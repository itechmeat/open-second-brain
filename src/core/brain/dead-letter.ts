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
import { compactRunStamp, isoSecond } from "./time.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** Only schema version currently understood. Unknown versions are refused. */
export const DEAD_LETTER_SCHEMA_VERSION = 1 as const;

/** Subdirectory under the machine-artifact root holding one JSON per record. */
const DEAD_LETTER_DIR = "dead-letters";

/** Hex characters of the content digest that makes an id unique. */
const ID_DIGEST_CHARS = 12;

/** The `<lane>-<stamp>-<digest>` id shape, as the reader validates it. */
const ID_RE = /^[a-z][a-z0-9-]*-\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]+$/;

/**
 * Lanes that commit several artifacts from one validated payload, and so
 * may record a dead letter. A union rather than an open string: a new
 * lane joining this list is a decision somebody types, and the compiler
 * asks for it at every call site.
 */
export type DeadLetterLane = "extract-signals";

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

/** One persisted dead letter. */
export interface DeadLetterRecord {
  readonly schema_version: typeof DEAD_LETTER_SCHEMA_VERSION;
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
 * The id is derived from the record's own content, so re-recording an
 * identical failure rewrites one file rather than accumulating one per
 * retry, while a different failure - different items missing, different
 * error - gets its own. No lock: each record is a whole file written
 * atomically under a content-derived name, so there is no read-modify-
 * write for two writers to race on.
 */
export function recordDeadLetter(vault: string, input: RecordDeadLetterInput): DeadLetterRecord {
  const { envelope, report, firstError, now } = input;
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
    outcome: deriveReconciliationOutcome(report),
    first_error: message,
  };
  const id = `${envelope.lane}-${compactRunStamp(now)}-${sha256Hex(canonicalJson(body)).slice(0, ID_DIGEST_CHARS)}`;
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
 * Every record this vault holds, newest id last (the id carries the
 * stamp, so lexical order is chronological within a lane). An absent
 * directory is an empty list - nothing has ever failed part way - while
 * an unreadable record throws, because a listing that skipped it would
 * under-report the very thing it is for.
 */
export function listDeadLetters(vault: string): ReadonlyArray<DeadLetterRecord> {
  const dir = deadLetterDir(vault);
  if (!existsSync(dir)) return Object.freeze([]);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .toSorted((a, b) => a.localeCompare(b));
  return Object.freeze(names.map((name) => parseRecord(join(dir, name))));
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
  if (obj["schema_version"] !== DEAD_LETTER_SCHEMA_VERSION) {
    throw new DeadLetterError(
      `dead letter schema_version ${String(obj["schema_version"])} not supported ` +
        `(expected ${DEAD_LETTER_SCHEMA_VERSION}): ${path}`,
    );
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
    schema_version: DEAD_LETTER_SCHEMA_VERSION,
    id: requireString(obj, "id", path),
    lane: requireString(obj, "lane", path) as DeadLetterLane,
    step: requireString(obj, "step", path),
    reference: requireString(obj, "reference", path),
    target: requireString(obj, "target", path),
    attempted: requireNumber(obj, "attempted", path),
    found: requireNumber(obj, "found", path),
    missing: Object.freeze([...(missing as ReadonlyArray<string>)]),
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
