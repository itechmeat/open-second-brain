/**
 * Durable dead letters for multi-artifact write lanes
 * (nothing-writes-silently, unit E).
 *
 * One lane in this project commits SEVERAL artifacts from one validated
 * envelope payload: `commitExtractedSignals` writes a file per mined
 * signal. A failure on the fourth leaves three on disk, and until now the
 * only record of that state was the thrown error - which lives exactly as
 * long as the response that carried it. A caller that dropped the
 * response left a vault holding three signals nobody knows about and a
 * payload nobody knows was half-applied.
 *
 * This module is the record that outlives the response. It is deliberately
 * NOT for single-artifact lanes (the design's dead-letter boundary): a
 * design note or a research report either lands or does not, and its one
 * failure IS the response. Widening this to every write would make a
 * durable file out of every transient error and bury the case that
 * matters.
 *
 * ## Shape and vocabulary
 *
 * A record answers "what did this lane try, what landed, and what did
 * not" in the wave's SHARED reconciliation vocabulary - `attempted`,
 * `found`, `missing` with the missing keys NAMED (see
 * `src/core/reconciliation-report.ts`). No dialect: the same three words
 * the import read-back census and the embedder audit use. Beside them it
 * carries the lane, the envelope identity the payload answered, and the
 * first real error, so an operator reading the file knows which payload
 * to re-run and why the run stopped.
 *
 * Since schema 2 it also carries the payload itself, frozen at failure
 * time: the producer's validated payload, recorded so recovery can re-run
 * the exact write that failed part way without a second model call. The
 * freeze may redact free-text fields and keep each item's original dedup
 * hash beside it (the extraction lane does: the letter lives forever and
 * the dead-letters surfaces print it) - the identity a re-run dedups
 * against survives, the raw text does not. A v1 letter names the payload
 * but does not carry it, and still parses - it is the recovery layer's
 * business what that means, not this module's (see
 * `dead-letter-recovery.ts`).
 *
 * ## Where it lives, and why nothing here deletes it
 *
 * Under `<vault>/.open-second-brain/dead-letters/`, the machine-artifact
 * root the ingest checkpoint and the content manifest already use, with
 * the same atomic-write and vault-identity discipline. It is a declared
 * `STATE_SURFACES` row, so `o2b state status` names the location and a
 * state migration moves it with everything else.
 *
 * RETENTION: nothing in this project removes a dead letter. The whole
 * point of the file is to be the only surviving evidence of a partial
 * write, and a tool that swept it on a schedule - or cleared it on the
 * next successful run - would delete exactly the evidence somebody had
 * not read yet. Removing one is an operator action on a named file, taken
 * once the payload has been reconciled. The records are small and are
 * written only when a multi-artifact commit fails part way, so there is
 * no growth to manage; `listDeadLetters` is the read API that says what
 * is there, and no MCP tool is added for it.
 *
 * ## Reading refuses rather than skips
 *
 * A corrupt file or an unknown `schema_version` is a hard error, on the
 * single read and on the listing alike. A skip would turn "the record of
 * a partial write is unreadable" into "there was no partial write", which
 * is the failure this module exists to prevent, one level up.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import {
  deriveReconciliationOutcome,
  isReconciliationOutcome,
  type ReconciliationOutcome,
  type ReconciliationReport,
} from "../reconciliation-report.ts";
import { DERIVED_STORE_DIR } from "./path-constants.ts";
import { isoSecond } from "./time.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/**
 * Only schema version currently WRITTEN. Parsing is strict per version
 * over {@link PARSED_DEAD_LETTER_SCHEMA_VERSIONS}: schema 2 freezes the
 * failing commit's validated payload into the record (one-command
 * recovery, t_50794f57), schema 1 letters keep parsing - payload-less,
 * exactly as their writer left them - and anything else is refused, so a
 * version this build does not understand can never be read as one it
 * does.
 */
export const DEAD_LETTER_SCHEMA_VERSION = 2 as const;

/**
 * Every schema version this build parses. A list rather than a range
 * check: accepting a version is a decision per version, and the type
 * below is derived from it so a parser branch and the record type cannot
 * drift apart.
 */
export const PARSED_DEAD_LETTER_SCHEMA_VERSIONS = Object.freeze([
  1,
  DEAD_LETTER_SCHEMA_VERSION,
] as const);

/** A schema version a record on disk may carry. */
export type DeadLetterSchemaVersion = (typeof PARSED_DEAD_LETTER_SCHEMA_VERSIONS)[number];

/**
 * Whether `value` is a schema version this build parses. The reader's
 * version gate: the guard is the list itself, so a version the constant
 * admits parses the day it lands and the gate cannot drift behind the
 * type; what each accepted version carries is still a decision per
 * version, made by the parser's own branches.
 */
function isParsedDeadLetterSchemaVersion(value: unknown): value is DeadLetterSchemaVersion {
  return (PARSED_DEAD_LETTER_SCHEMA_VERSIONS as ReadonlyArray<unknown>).includes(value);
}

/** Subdirectory under the machine-artifact root holding one JSON per record. */
const DEAD_LETTER_DIR = "dead-letters";

/** Hex characters of the content digest that makes an id unique. */
const ID_DIGEST_CHARS = 12;

/** The `<lane>-<digest>` id shape, as the reader validates it. */
const ID_RE = new RegExp(`^[a-z][a-z0-9-]*-[0-9a-f]{${ID_DIGEST_CHARS}}$`);

/**
 * Lanes that commit several artifacts from one validated payload, and so
 * may record a dead letter. A union rather than an open string: a new
 * lane joining this list is a decision somebody types, and the compiler
 * asks for it at every call site.
 */
export type DeadLetterLane = "extract-signals";

/**
 * The lane union at runtime, for readers of records from disk: a record's
 * `lane` field is a string from JSON, and a lane this build does not know
 * has to be nameable as such rather than silently treated as one it does.
 * A new member joining {@link DeadLetterLane} is added here in the same
 * edit.
 */
export const DEAD_LETTER_LANES: ReadonlyArray<DeadLetterLane> = Object.freeze(["extract-signals"]);

/** Whether `value` names a lane this build commits multi-artifact writes in. */
export function isDeadLetterLane(value: string): value is DeadLetterLane {
  return (DEAD_LETTER_LANES as ReadonlyArray<string>).includes(value);
}

/** Which payload, from which lane, the unwritten items belonged to. */
export interface DeadLetterEnvelopeIdentity {
  readonly lane: DeadLetterLane;
  /** The needs-llm-step step name the payload answered. */
  readonly step: string;
  /** The lane's own identity for this payload - a session id, a plan id. */
  readonly reference: string;
  /** Vault-relative destination the artifacts were bound for. */
  readonly target: string;
}

/**
 * The frozen payload a schema-2 record carries: the producer's validated
 * payload as the lane froze it, so recovery can re-run the exact write
 * that failed part way without a second model call. The shape is the
 * lane's own - this module never looks inside it, so a future lane may
 * freeze a different envelope here without this file learning its
 * fields. A lane whose payload carries free text redacts it at freeze
 * time and keeps the pre-redaction dedup identity beside it; recovery
 * reads whatever shape the lane froze.
 */
export interface DeadLetterPayload {
  readonly [key: string]: unknown;
}

/** One persisted dead letter. */
export interface DeadLetterRecord {
  readonly schema_version: DeadLetterSchemaVersion;
  readonly id: string;
  readonly lane: DeadLetterLane;
  readonly step: string;
  readonly reference: string;
  readonly target: string;
  /** Artifacts the commit set out to write. */
  readonly attempted: number;
  /** Artifacts whose bytes reached disk. */
  readonly found: number;
  /** Keys naming every artifact that did NOT reach disk. */
  readonly missing: ReadonlyArray<string>;
  /**
   * The validated payload this commit was writing, frozen at failure
   * time. Present only on schema-2 records whose producer recorded it:
   * the field is optional because a v2 record from a lane that freezes
   * nothing is still a well-formed record, and the recovery layer - not
   * this module - decides what its absence means.
   */
  readonly payload?: DeadLetterPayload;
  readonly outcome: ReconciliationOutcome;
  /** Message of the first real error, verbatim. */
  readonly first_error: string;
  readonly recorded_at: string;
}

export interface RecordDeadLetterInput {
  readonly envelope: DeadLetterEnvelopeIdentity;
  readonly report: ReconciliationReport;
  /** The error that stopped the commit; anything throwable. */
  readonly firstError: unknown;
  /**
   * The validated payload to freeze into the record. A multi-artifact
   * lane that can be recovered by re-running its payload passes it here;
   * the id is derived over it, so two failures differing only in what
   * they tried to write are distinct records.
   */
  readonly payload?: DeadLetterPayload;
  readonly now: Date;
}

/** What {@link tryRecordDeadLetter} managed to do, either way. */
export type DeadLetterOutcome =
  | { readonly recorded: true; readonly id: string; readonly path: string }
  | { readonly recorded: false; readonly reason: string };

/** A dead letter could not be written, or one on disk could not be read. */
export class DeadLetterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeadLetterError";
  }
}

/** Directory holding this vault's dead letters. */
export function deadLetterDir(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, DEAD_LETTER_DIR);
}

/** Absolute path of one record. */
export function deadLetterPath(vault: string, id: string): string {
  if (!ID_RE.test(id)) {
    throw new DeadLetterError(`invalid dead-letter id: ${JSON.stringify(id)}`);
  }
  return join(deadLetterDir(vault), `${id}.json`);
}

/**
 * Write one dead letter and return it.
 *
 * The id is derived from the record's own content and NOTHING else - no
 * clock - so re-recording an identical failure rewrites one file rather
 * than accumulating one per retry, while a different failure - different
 * items missing, different error - gets its own. The retry rewrites
 * `recorded_at`, so the one file names the most recent attempt; a
 * timestamp in the id instead would have made a deterministically-failing
 * payload retried twenty times into twenty byte-identical files in a
 * directory nothing prunes. No lock: each record is a whole file written
 * atomically under a content-derived name, so there is no read-modify-
 * write for two writers to race on.
 */
export function recordDeadLetter(vault: string, input: RecordDeadLetterInput): DeadLetterRecord {
  const { envelope, report, firstError, payload, now } = input;
  requireContent("step", envelope.step);
  requireContent("reference", envelope.reference);
  requireContent("target", envelope.target);
  if (report.missing.length === 0) {
    throw new DeadLetterError(
      "a dead letter must name at least one unwritten item; this report names none",
    );
  }
  const message = firstError instanceof Error ? firstError.message : String(firstError);
  requireContent("first_error", message);

  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);

  const body = {
    schema_version: DEAD_LETTER_SCHEMA_VERSION,
    lane: envelope.lane,
    step: envelope.step.trim(),
    reference: envelope.reference.trim(),
    target: envelope.target.trim(),
    attempted: report.attempted,
    found: report.found,
    missing: Object.freeze([...report.missing]),
    ...(payload !== undefined ? { payload } : {}),
    outcome: deriveReconciliationOutcome(report),
    first_error: message,
  };
  const id = `${envelope.lane}-${sha256Hex(canonicalJson(body)).slice(0, ID_DIGEST_CHARS)}`;
  const record: DeadLetterRecord = Object.freeze({
    ...body,
    id,
    recorded_at: isoSecond(now),
  });
  atomicWriteFileSync(deadLetterPath(vault, id), `${JSON.stringify(serialize(record), null, 2)}\n`);
  return record;
}

/**
 * {@link recordDeadLetter} for a caller that is already inside a catch
 * block. It NEVER throws: the error the caller is holding is the one that
 * has to reach the operator, and a recorder that raised over it would
 * replace a partial-write report with a filesystem complaint. The failure
 * is not swallowed either - the reason comes back on the outcome, for the
 * caller to name in its own refusal.
 */
export function tryRecordDeadLetter(
  vault: string,
  input: RecordDeadLetterInput,
): DeadLetterOutcome {
  try {
    const record = recordDeadLetter(vault, input);
    return Object.freeze({
      recorded: true as const,
      id: record.id,
      path: deadLetterPath(vault, record.id),
    });
  } catch (err) {
    return Object.freeze({
      recorded: false as const,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read one record, or null when nothing was ever written under that id. */
export function readDeadLetter(vault: string, id: string): DeadLetterRecord | null {
  const path = deadLetterPath(vault, id);
  if (!existsSync(path)) return null;
  return parseRecord(path);
}

/**
 * Every record this vault holds, newest last. Ordered by `recorded_at`
 * off the parsed records rather than by filename: the id is a content
 * digest and carries no clock, so lexical order over the directory would
 * be arbitrary. The id breaks a tie, so the order is total. An absent
 * directory is an empty list - nothing has ever failed part way - while
 * an unreadable record throws, because a listing that skipped it would
 * under-report the very thing it is for.
 */
export function listDeadLetters(vault: string): ReadonlyArray<DeadLetterRecord> {
  const dir = deadLetterDir(vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const records = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => parseRecord(join(dir, name)));
  return Object.freeze(
    records.toSorted(
      (a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id),
    ),
  );
}

function parseRecord(path: string): DeadLetterRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new DeadLetterError(`dead letter is corrupt JSON: ${path}`, { cause: err });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DeadLetterError(`dead letter is not an object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj["schema_version"];
  if (!isParsedDeadLetterSchemaVersion(version)) {
    throw new DeadLetterError(
      `dead letter schema_version ${String(version)} not supported ` +
        `(this build parses ${PARSED_DEAD_LETTER_SCHEMA_VERSIONS.join(" and ")}): ${path}`,
    );
  }
  // Strict per version: a v1 record never carried a payload, so one that
  // claims it is not a v1 record and is refused rather than silently
  // promoted; a v2 record may carry the frozen payload, and when it does
  // the payload must be an object - the lane's own envelope - never a
  // bare list, a string or null.
  let payload: DeadLetterPayload | undefined;
  if (version === 1) {
    if (obj["payload"] !== undefined) {
      throw new DeadLetterError(`dead letter schema_version 1 must not carry a payload: ${path}`);
    }
  } else if (obj["payload"] !== undefined) {
    const raw = obj["payload"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DeadLetterError(`dead letter payload is not an object: ${path}`);
    }
    payload = Object.freeze({ ...(raw as object) });
  }
  const missing = obj["missing"];
  if (!Array.isArray(missing) || missing.some((key) => typeof key !== "string")) {
    throw new DeadLetterError(`dead letter has no readable missing key list: ${path}`);
  }
  const outcome = obj["outcome"];
  if (!isReconciliationOutcome(outcome)) {
    throw new DeadLetterError(`dead letter carries an unknown outcome: ${path}`);
  }
  return Object.freeze({
    schema_version: version,
    id: requireString(obj, "id", path),
    lane: requireString(obj, "lane", path) as DeadLetterLane,
    step: requireString(obj, "step", path),
    reference: requireString(obj, "reference", path),
    target: requireString(obj, "target", path),
    attempted: requireNumber(obj, "attempted", path),
    found: requireNumber(obj, "found", path),
    missing: Object.freeze([...(missing as ReadonlyArray<string>)]),
    ...(payload !== undefined ? { payload } : {}),
    outcome,
    first_error: requireString(obj, "first_error", path),
    recorded_at: requireString(obj, "recorded_at", path),
  });
}

/** Serialized field order, fixed so a re-record is byte-identical. */
function serialize(record: DeadLetterRecord): Record<string, unknown> {
  return {
    schema_version: record.schema_version,
    id: record.id,
    lane: record.lane,
    step: record.step,
    reference: record.reference,
    target: record.target,
    attempted: record.attempted,
    found: record.found,
    missing: [...record.missing],
    ...(record.payload !== undefined ? { payload: record.payload } : {}),
    outcome: record.outcome,
    first_error: record.first_error,
    recorded_at: record.recorded_at,
  };
}

function requireContent(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new DeadLetterError(`dead letter: ${field} must be a non-empty string`);
  }
}

function requireString(obj: Record<string, unknown>, field: string, path: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DeadLetterError(`dead letter has no readable ${field}: ${path}`);
  }
  return value;
}

function requireNumber(obj: Record<string, unknown>, field: string, path: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DeadLetterError(`dead letter has no readable ${field}: ${path}`);
  }
  return value;
}
