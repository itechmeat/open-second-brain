/**
 * Trigger store with anti-nag lifecycle (Workspace Insight Suite,
 * t_cd1fee79).
 *
 * Each trigger is one Markdown file under `Brain/triggers/` - operator
 * readable without tooling, frontmatter carries the machine state.
 * History is a status change, not a file move: terminal triggers
 * (acted / dismissed / expired / suppressed) stay in place so `history`
 * is just a status filter and the cooldown logic can see them.
 *
 * Anti-nag invariants live here and only here:
 *   - cooldown-key dedup across ALL statuses makes repeated scans
 *     idempotent (a suppressed twin always blocks; an open twin always
 *     blocks; a dismissed or acted twin blocks for `cooldownDays` after
 *     its resolution; an expired twin allows);
 *   - lifecycle transitions: acknowledge / act / dismiss are allowed
 *     from ANY open state (an operator may act on a trigger they found
 *     via `list` before the brief ever delivered it - delivery is a
 *     surfacing step, not a gate), terminal states reject everything;
 *   - suppression is the one edge OUT of a terminal state: it is legal
 *     from any status, it carries no clock, and {@link transitionTrigger}
 *     restores the interrupted status verbatim on `unsuppress` because
 *     suppressing leaves the delivery and resolution instants untouched;
 *   - the recurrence ledger records every silenced candidate that HAS a
 *     record to write to, so a suppressed finding that keeps firing is
 *     auditable rather than invisible ({@link recordRecurrence});
 *   - brief delivery happens at most once per cooldown window
 *     ({@link briefTriggers} + {@link markTriggersDelivered});
 *   - an unreadable record is confined to itself. Every surface reads
 *     through {@link readTriggers}, which partitions the directory into
 *     the records it could parse and the ones it could not, so a single
 *     hand-edited file names itself instead of taking `list`, `history`,
 *     the brief, delivery, creation and the transitions down with it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { parseFrontmatterText } from "../../vault.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  isTriggerKind,
  isTriggerStatus,
  isTriggerUrgency,
  TRIGGER_KINDS,
  TRIGGER_OPEN_STATUSES,
  TRIGGER_STATUS,
  TRIGGER_STATUSES,
  TRIGGER_TERMINAL_STATUSES,
  TRIGGER_URGENCIES,
  type InsightCandidate,
  type TriggerRecord,
  type TriggerStatus,
} from "./types.ts";

export const TRIGGER_TTL_DAYS = 14;
export const TRIGGER_COOLDOWN_DAYS = 7;
export const TRIGGER_MAX_PER_KIND = 10;

/**
 * How long a held trigger-directory lock may sit before another process
 * treats it as abandoned. Exported so a test can hold the same lock the
 * writers take rather than guessing at its options.
 */
export const TRIGGER_LOCK_STALE_MS = 10_000;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Occurrences credited to a record that predates the recurrence ledger.
 * It is the count of occurrences anyone actually recorded for such a
 * record - the creation - and not a placeholder for an unknown number.
 */
const OCCURRENCES_WHEN_UNRECORDED = 1;

/** Longest run of an unreadable field value reproduced in an error. */
const FIELD_EXCERPT_MAX = 120;

/**
 * The frontmatter keys of a stored trigger, in one frozen table.
 *
 * The renderer, the parser and the refusal messages all read the names
 * from here, so a key can never be spelled one way on the way out and
 * another way on the way back in - and a refusal always quotes the same
 * name the operator sees in the file.
 */
const TRIGGER_KEY = Object.freeze({
  id: "trigger_id",
  kind: "trigger_type",
  status: "status",
  urgency: "urgency",
  cooldownKey: "cooldown_key",
  createdAt: "created_at",
  expiresAt: "expires_at",
  deliveredAt: "delivered_at",
  resolvedAt: "resolved_at",
  suppressedAt: "suppressed_at",
  suppressedFrom: "suppressed_from",
  occurrences: "occurrences",
  lastSeenAt: "last_seen_at",
  sourceArtifacts: "source_artifacts",
} as const);

/** Extension of every trigger record file under `Brain/triggers/`. */
const TRIGGER_FILE_EXT = ".md";

export function triggersDir(vault: string): string {
  return join(vault, "Brain", "triggers");
}

// ── Rendering and parsing ───────────────────────────────────────────────────

interface StoredTrigger extends Omit<TriggerRecord, "effectiveStatus"> {}

function renderTrigger(record: StoredTrigger): string {
  const lines = [
    "---",
    `${TRIGGER_KEY.id}: ${record.id}`,
    `${TRIGGER_KEY.kind}: ${record.kind}`,
    `${TRIGGER_KEY.status}: ${record.status}`,
    `${TRIGGER_KEY.urgency}: ${record.urgency}`,
    // Free-text and list values are JSON-quoted so YAML-significant
    // characters can never corrupt the file (intentions/handoff pattern).
    `${TRIGGER_KEY.cooldownKey}: ${JSON.stringify(record.cooldownKey)}`,
    `${TRIGGER_KEY.createdAt}: ${record.createdAt}`,
    `${TRIGGER_KEY.expiresAt}: ${record.expiresAt}`,
    ...(record.deliveredAt !== null ? [`${TRIGGER_KEY.deliveredAt}: ${record.deliveredAt}`] : []),
    ...(record.resolvedAt !== null ? [`${TRIGGER_KEY.resolvedAt}: ${record.resolvedAt}`] : []),
    ...(record.suppressedAt !== null
      ? [`${TRIGGER_KEY.suppressedAt}: ${record.suppressedAt}`]
      : []),
    ...(record.suppressedFrom !== null
      ? [`${TRIGGER_KEY.suppressedFrom}: ${record.suppressedFrom}`]
      : []),
    `${TRIGGER_KEY.occurrences}: ${record.occurrences}`,
    `${TRIGGER_KEY.lastSeenAt}: ${record.lastSeenAt}`,
    `${TRIGGER_KEY.sourceArtifacts}: ${JSON.stringify(record.sourceArtifacts)}`,
    "---",
    "",
    "## Reason",
    "",
    record.reason,
    "",
    "## Suggested action",
    "",
    record.suggestedAction,
    "",
  ];
  if (record.contextSnippets.length > 0) {
    lines.push("## Context", "");
    for (const snippet of record.contextSnippets) lines.push(`- ${snippet}`);
    lines.push("");
  }
  return lines.join("\n");
}

function sectionText(body: string, heading: string): string {
  const re = new RegExp(`^## ${heading}$`, "mu");
  const match = re.exec(body);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = /^## /mu.exec(body.slice(start + 1));
  const end = next ? start + 1 + next.index : body.length;
  return body.slice(start, end).trim();
}

/**
 * One frontmatter field of one record cannot be read.
 *
 * Absent and unreadable are different claims and this type is what keeps
 * them apart. An absent field means nobody ever recorded the thing, which
 * several fields here have an honest reading for; a present field that
 * does not parse means a record says something and the store cannot tell
 * what. Substituting the absent-field reading for the second case would
 * state a value nothing supports - which is the failure this whole wave
 * exists to remove - so it refuses, naming the file, the key, and the
 * operator's own bytes so the broken line can be found.
 *
 * The refusal is scoped to ONE record: {@link readTriggers} catches it
 * per file and reports it alongside the records that read cleanly, so a
 * broken line stops the record that carries it and nothing else.
 */
export class TriggerFieldError extends Error {
  /** The trigger file carrying the unreadable value. */
  readonly path: string;
  /** The frontmatter key that could not be read. */
  readonly key: string;

  constructor(path: string, key: string, detail: string) {
    super(`trigger ${path}: ${key} ${detail}`);
    this.name = "TriggerFieldError";
    this.path = path;
    this.key = key;
  }
}

/**
 * A file listed in the trigger directory that cannot be read at all.
 *
 * Distinct from {@link TriggerFieldError} because no single field is at
 * fault: the record may hold a perfectly good finding that this process
 * simply cannot open. Reporting it as an absent trigger would be the same
 * mistake one level up.
 */
export class TriggerFileError extends Error {
  /** The trigger file that could not be opened. */
  readonly path: string;

  constructor(path: string, cause: string) {
    super(`trigger ${path}: the file cannot be read: ${cause}`);
    this.name = "TriggerFileError";
    this.path = path;
  }
}

/** Detail for a value that is recorded and cannot be read. */
function presentButUnreadable(expectation: string, raw: unknown): string {
  return `is present but ${expectation}: ${excerptFieldValue(raw)}`;
}

/** Detail for a value every record must carry and this one does not. */
function absentButRequired(requirement: string): string {
  return `is missing, and ${requirement}`;
}

/**
 * A `source_artifacts` value that is present and cannot be read as a
 * list of strings.
 *
 * It is a refusal rather than an empty list on purpose. The grounding
 * artifacts are the evidence a finding rests on, so a trigger reporting
 * none is a materially different claim from a trigger whose evidence
 * could not be read - and the earlier behaviour, which degraded a
 * hand-edited list to `[]`, made an unparseable finding present as an
 * ungrounded one with nothing anywhere saying so.
 */
export class TriggerSourceArtifactsError extends TriggerFieldError {
  constructor(path: string, raw: unknown) {
    super(path, TRIGGER_KEY.sourceArtifacts, presentButUnreadable("not a list of strings", raw));
    this.name = "TriggerSourceArtifactsError";
  }
}

/**
 * Operator bytes bounded to one line, so an error message stays one
 * line whatever the file contains. The value is reproduced verbatim and
 * never inspected - it is opaque content, quoted back so the operator
 * can find the line they broke.
 */
function excerptFieldValue(raw: unknown): string {
  const text = typeof raw === "string" ? raw : String(raw);
  return text.length <= FIELD_EXCERPT_MAX ? text : `${text.slice(0, FIELD_EXCERPT_MAX)}…`;
}

/**
 * Read the grounding artifact list. An absent key names no artifacts and
 * yields an empty list; a present but unreadable one throws - see
 * {@link TriggerSourceArtifactsError}.
 */
function parseArtifactList(raw: unknown, path: string): ReadonlyArray<string> {
  if (raw === undefined) return Object.freeze([]);
  // Defensive: a frontmatter parser that materializes the value as a
  // real array round-trips too.
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    return Object.freeze([...raw]);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return Object.freeze(parsed);
      }
    } catch {
      // fall through to the refusal below
    }
  }
  throw new TriggerSourceArtifactsError(path, raw);
}

/**
 * The recorded occurrence count.
 *
 * An ABSENT key yields {@link OCCURRENCES_WHEN_UNRECORDED}: the record
 * predates the ledger, and one - its creation - is the count of
 * occurrences anybody actually recorded for it. A PRESENT key that does
 * not read as a positive integer refuses, because crediting a corrupt
 * counter that same one would understate a finding that has fired forty
 * times and would make a hand-edit indistinguishable from a record
 * written before the ledger existed.
 *
 * The numeric arm is not defensive dressing: the count is written as a
 * bare integer, so a frontmatter parser that materializes it as a number
 * must not fall through and quietly discard a real count.
 */
function parseOccurrences(raw: unknown, path: string): number {
  if (raw === undefined) return OCCURRENCES_WHEN_UNRECORDED;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < OCCURRENCES_WHEN_UNRECORDED) {
    throw new TriggerFieldError(
      path,
      TRIGGER_KEY.occurrences,
      presentButUnreadable("not a positive integer", raw),
    );
  }
  return parsed;
}

/**
 * The instant the trigger was created.
 *
 * Required, and refused here rather than defaulted, because every later
 * use treats it as a real instant: it orders the listing, it is the
 * honest reading of an absent `last_seen_at`, and it is written back
 * verbatim on every recurrence. The empty string this used to substitute
 * did not stay a read-time inconvenience - the first recurrence write
 * emitted `last_seen_at:` with nothing after it, the next read
 * materialised that as `""` and refused THAT field, so a record with no
 * creation instant became permanently unreadable one write later and
 * blamed a line the operator never touched. Refusing at the origin keeps
 * the report pointing at the field that is actually missing.
 */
function parseCreatedAt(raw: unknown, path: string): string {
  if (raw === undefined) {
    throw new TriggerFieldError(
      path,
      TRIGGER_KEY.createdAt,
      absentButRequired("a trigger is ordered, dated and aged by it"),
    );
  }
  const text = typeof raw === "string" ? raw : String(raw);
  if (text.length === 0 || Number.isNaN(Date.parse(text))) {
    throw new TriggerFieldError(
      path,
      TRIGGER_KEY.createdAt,
      presentButUnreadable("not a readable instant", raw),
    );
  }
  return text;
}

/**
 * The instant the finding was last seen.
 *
 * An ABSENT key yields the creation instant: a record predating the
 * ledger last fired when it was created, and that is a true statement
 * about it - {@link parseCreatedAt} has already established that the
 * substitute is a real instant, so this reading can never manufacture an
 * unreadable value. A PRESENT key that is not a readable instant
 * refuses, for the same reason the occurrence count does.
 */
function parseLastSeenAt(raw: unknown, createdAt: string, path: string): string {
  if (raw === undefined) return createdAt;
  const text = typeof raw === "string" ? raw : String(raw);
  if (text.length === 0 || Number.isNaN(Date.parse(text))) {
    throw new TriggerFieldError(
      path,
      TRIGGER_KEY.lastSeenAt,
      presentButUnreadable("not a readable instant", raw),
    );
  }
  return text;
}

/**
 * A frontmatter value read as text, or "" when the key holds no string.
 * Used for the fields whose absence and whose emptiness are the same
 * claim to every reader below.
 */
function textOrEmpty(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/** A frontmatter value read as text, or `null` when nothing recorded one. */
function textOrNull(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

function effectiveStatus(status: TriggerStatus, expiresAt: string, now: Date): TriggerStatus {
  // Expiry applies to open statuses only, which is precisely what makes
  // `suppressed` indefinite: it is terminal, so no clock reaches it.
  if (!TRIGGER_OPEN_STATUSES.has(status)) return status;
  const expiry = Date.parse(expiresAt);
  if (Number.isFinite(expiry) && now.getTime() > expiry) return "expired";
  return status;
}

/**
 * Read one file as a trigger record.
 *
 * `null` means the file is not a trigger record at all: it carries no
 * `trigger_id`, so nothing claims it belongs to the queue and skipping it
 * omits no finding - an operator may keep their own notes in the
 * directory. Every OTHER failure throws {@link TriggerFieldError} naming
 * the field, because a file that says it is trigger `tr-…` and then
 * cannot be read is a finding the store must not pretend is absent.
 */
function parseTrigger(vault: string, fileName: string, now: Date): TriggerRecord | null {
  const path = join(triggersDir(vault), fileName);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new TriggerFileError(path, (err as Error).message ?? String(err));
  }
  const [meta, body] = parseFrontmatterText(raw);
  const id = meta[TRIGGER_KEY.id];
  if (id === undefined) return null;
  if (typeof id !== "string" || id === "") {
    throw new TriggerFieldError(path, TRIGGER_KEY.id, presentButUnreadable("not an id", id));
  }
  const kind = meta[TRIGGER_KEY.kind];
  if (typeof kind !== "string" || !isTriggerKind(kind)) {
    throw new TriggerFieldError(
      path,
      TRIGGER_KEY.kind,
      presentButUnreadable(`not one of ${TRIGGER_KINDS.join(", ")}`, kind),
    );
  }
  const status = meta[TRIGGER_KEY.status];
  if (typeof status !== "string" || !isTriggerStatus(status)) {
    throw new TriggerFieldError(
      path,
      TRIGGER_KEY.status,
      presentButUnreadable(`not one of ${TRIGGER_STATUSES.join(", ")}`, status),
    );
  }
  const urgency = meta[TRIGGER_KEY.urgency];
  if (typeof urgency !== "string" || !isTriggerUrgency(urgency)) {
    throw new TriggerFieldError(
      path,
      TRIGGER_KEY.urgency,
      presentButUnreadable(`not one of ${TRIGGER_URGENCIES.join(", ")}`, urgency),
    );
  }
  const createdAt = parseCreatedAt(meta[TRIGGER_KEY.createdAt], path);
  const expiresAt = textOrEmpty(meta[TRIGGER_KEY.expiresAt]);
  const suppressedFrom = meta[TRIGGER_KEY.suppressedFrom];
  return Object.freeze({
    id,
    kind,
    status,
    effectiveStatus: effectiveStatus(status, expiresAt, now),
    urgency,
    reason: sectionText(body, "Reason"),
    suggestedAction: sectionText(body, "Suggested action"),
    sourceArtifacts: parseArtifactList(meta[TRIGGER_KEY.sourceArtifacts], path),
    contextSnippets: Object.freeze(
      sectionText(body, "Context")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2)),
    ),
    cooldownKey: textOrEmpty(meta[TRIGGER_KEY.cooldownKey]),
    createdAt,
    expiresAt,
    deliveredAt: textOrNull(meta[TRIGGER_KEY.deliveredAt]),
    resolvedAt: textOrNull(meta[TRIGGER_KEY.resolvedAt]),
    suppressedAt: textOrNull(meta[TRIGGER_KEY.suppressedAt]),
    suppressedFrom: isTriggerStatus(suppressedFrom) ? suppressedFrom : null,
    occurrences: parseOccurrences(meta[TRIGGER_KEY.occurrences], path),
    lastSeenAt: parseLastSeenAt(meta[TRIGGER_KEY.lastSeenAt], createdAt, path),
    path,
  });
}

function writeRecord(record: TriggerRecord): void {
  const { effectiveStatus: _ignored, ...stored } = record;
  atomicWriteFileSync(record.path, renderTrigger(stored));
}

// ── Listing ─────────────────────────────────────────────────────────────────

export interface ListTriggersOptions {
  readonly now: Date;
  /** Filter on EFFECTIVE status (expiry applied). */
  readonly status?: TriggerStatus;
}

/**
 * One record in the queue that could not be read, ready to be named.
 *
 * It exists so that "the queue holds nothing" and "the queue holds
 * something this process cannot read" are different answers at every
 * boundary above the store. Surfaces project it with
 * {@link unreadableTriggerJson} or render it with
 * {@link renderTriggerQueueFailures}.
 */
export interface UnreadableTrigger {
  /** The file the unreadable record lives in. */
  readonly path: string;
  /**
   * The frontmatter key at fault, or `null` when the file itself could
   * not be read and so no single field can be blamed.
   */
  readonly key: string | null;
  /** The refusal, whose message already names the file and the key. */
  readonly error: Error;
}

/** The trigger directory split into what could be read and what could not. */
export interface TriggerScan {
  /** Readable records, newest first (created_at desc, then id). */
  readonly records: ReadonlyArray<TriggerRecord>;
  /** Records that named themselves and then failed to parse, by path. */
  readonly unreadable: ReadonlyArray<UnreadableTrigger>;
}

const EMPTY_SCAN: TriggerScan = Object.freeze({
  records: Object.freeze([]),
  unreadable: Object.freeze([]),
});

/** Describe a per-record refusal, or `null` for anything else. */
function asUnreadable(err: unknown): UnreadableTrigger | null {
  if (err instanceof TriggerFieldError) {
    return Object.freeze({ path: err.path, key: err.key, error: err });
  }
  if (err instanceof TriggerFileError) {
    return Object.freeze({ path: err.path, key: null, error: err });
  }
  return null;
}

/**
 * Read the whole trigger directory, keeping a broken record's blast
 * radius to itself.
 *
 * This is the reader every surface goes through. A refusal from one file
 * is caught here and reported in {@link TriggerScan.unreadable} next to
 * the records that read cleanly, which is what lets an operator see a
 * healthy trigger - and dismiss or suppress it - while a hand-edited
 * sibling is still broken. Anything that is not a per-record refusal
 * propagates: a bug in this module must not be filed against the
 * operator's file.
 *
 * The status filter applies to the readable records only. An unreadable
 * record has no status to compare, and dropping it from a filtered view
 * would hide it exactly where a caller is most likely to conclude the
 * queue is empty.
 */
export function readTriggers(vault: string, opts: ListTriggersOptions): TriggerScan {
  const dir = triggersDir(vault);
  if (!existsSync(dir)) return EMPTY_SCAN;
  const records: TriggerRecord[] = [];
  const unreadable: UnreadableTrigger[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(TRIGGER_FILE_EXT)) continue;
    let record: TriggerRecord | null;
    try {
      record = parseTrigger(vault, name, opts.now);
    } catch (err) {
      const entry = asUnreadable(err);
      if (entry === null) throw err;
      unreadable.push(entry);
      continue;
    }
    if (record === null) continue;
    if (opts.status !== undefined && record.effectiveStatus !== opts.status) continue;
    records.push(record);
  }
  records.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Object.freeze({ records: Object.freeze(records), unreadable: Object.freeze(unreadable) });
}

/**
 * Every trigger, newest first, or a refusal if any record is unreadable.
 *
 * The all-or-nothing view, for a caller that has no way to report a
 * partial one and must not act on it silently. It never drops a record:
 * an unreadable file surfaces as the original refusal, naming the file
 * and the field. Surfaces that report to an operator use
 * {@link readTriggers} instead, so one broken record does not deny them
 * the rest of the queue.
 */
export function listTriggers(
  vault: string,
  opts: ListTriggersOptions,
): ReadonlyArray<TriggerRecord> {
  const scan = readTriggers(vault, opts);
  const [first] = scan.unreadable;
  if (first !== undefined) throw first.error;
  return scan.records;
}

/** Envelope projection of one unreadable record. */
export function unreadableTriggerJson(entry: UnreadableTrigger): Record<string, unknown> {
  return { path: entry.path, key: entry.key, error: entry.error.message };
}

/** Heading of the block naming records the store could not read. */
export const UNREADABLE_TRIGGERS_HEADING = "## Unreadable triggers";

/** Heading of the block reporting that the queue could not be read at all. */
export const TRIGGER_QUEUE_UNREADABLE_HEADING = "## Trigger queue unreadable";

/** What a surface could not read about the trigger queue. */
export interface TriggerQueueFailures {
  /** Records that named themselves and could not be parsed. */
  readonly unreadable: ReadonlyArray<UnreadableTrigger>;
  /** Why the queue could not be read at all, or `null` when it was read. */
  readonly queueError: string | null;
}

/**
 * Everything a surface could not read about the queue, in one read.
 *
 * A per-record refusal lands in `unreadable`; a read that fails outright
 * - a vault that is not there, a directory that cannot be listed -
 * becomes `queueError`. Either way the caller has something to say, which
 * is the point: "the queue is empty" must never be the answer to "the
 * queue could not be read".
 */
export function readTriggerQueueFailures(vault: string, now: Date): TriggerQueueFailures {
  try {
    return Object.freeze({
      unreadable: readTriggers(vault, { now }).unreadable,
      queueError: null,
    });
  } catch (err) {
    return Object.freeze({
      unreadable: Object.freeze([]),
      queueError: (err as Error).message ?? String(err),
    });
  }
}

/**
 * The Markdown block a brief appends so an unreadable queue is never
 * rendered as an empty one.
 *
 * Returns "" only when there is genuinely nothing to report, which is
 * what lets a caller append it unconditionally: the pending-trigger
 * section being absent then means the queue was read and held nothing,
 * and that is the whole point of the block existing.
 */
export function renderTriggerQueueFailures(failures: TriggerQueueFailures): string {
  const blocks: string[] = [];
  if (failures.queueError !== null) {
    blocks.push([TRIGGER_QUEUE_UNREADABLE_HEADING, "", failures.queueError].join("\n"));
  }
  if (failures.unreadable.length > 0) {
    blocks.push(
      [
        UNREADABLE_TRIGGERS_HEADING,
        "",
        ...failures.unreadable.map((entry) => `- ${entry.error.message}`),
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

// ── Creation with cooldown dedup ────────────────────────────────────────────

export interface CreateTriggersOptions {
  readonly now: Date;
  /** Days a terminal (dismissed/acted) twin blocks recreation. */
  readonly cooldownDays?: number;
  /** Days until a fresh trigger expires. */
  readonly ttlDays?: number;
  /** Per-kind cap for one scan. */
  readonly maxPerKind?: number;
}

/**
 * One candidate that produced no new trigger, and why.
 *
 * `invalid` - the candidate named no cooldown key or no reason.
 * `duplicate` - a candidate earlier in the SAME scan already claimed
 *   this cooldown key; one scan seeing one finding twice is one
 *   occurrence, so this reason never writes to the ledger.
 * `active` / `cooldown` / `suppressed` - an existing record blocked it,
 *   and that record's ledger records the recurrence.
 * `kind-cap` - the per-kind budget for this scan was already spent.
 */
export interface SkippedCandidate {
  readonly cooldownKey: string;
  readonly reason: "active" | "cooldown" | "duplicate" | "kind-cap" | "invalid" | "suppressed";
}

export interface CreateTriggersResult {
  readonly created: ReadonlyArray<TriggerRecord>;
  readonly skipped: ReadonlyArray<SkippedCandidate>;
  /**
   * Records already in the queue that could not be read. A scan proceeds
   * around them - one broken file must not cost a run all of its new
   * findings - and names them here so the run is not reported as clean.
   */
  readonly unreadable: ReadonlyArray<UnreadableTrigger>;
}

function blockReason(
  twin: TriggerRecord,
  now: Date,
  cooldownDays: number,
): SkippedCandidate["reason"] | null {
  // Suppression comes first and carries no clock: the operator judged
  // this cooldown key structurally benign, so no arithmetic below can
  // ever let it back through.
  if (twin.effectiveStatus === TRIGGER_STATUS.suppressed) return "suppressed";
  if (TRIGGER_OPEN_STATUSES.has(twin.effectiveStatus)) return "active";
  if (twin.effectiveStatus === TRIGGER_STATUS.expired) return null;
  // dismissed / acted: silent for the cooldown window after resolution.
  const resolved = twin.resolvedAt !== null ? Date.parse(twin.resolvedAt) : Number.NaN;
  if (!Number.isFinite(resolved)) return null;
  return now.getTime() < resolved + cooldownDays * DAY_MS ? "cooldown" : null;
}

/**
 * Record that a finding fired again while the queue stayed silent.
 *
 * Written for every candidate an existing record silenced, whatever
 * silenced it - suppression, an open twin, a cooldown window, or the
 * per-kind cap - because the event worth keeping is "the finding fired
 * and nothing surfaced", and the reason it did not surface changes
 * nothing about that. Without it a suppressed finding that recurs daily
 * is indistinguishable from one that never fired again.
 *
 * A candidate silenced when NO record exists for its cooldown key has no
 * ledger to write to and is reported in
 * {@link CreateTriggersResult.skipped} alone; a second candidate on one
 * key inside one scan is one occurrence and is not counted twice.
 *
 * Callers must hold the trigger-directory lock. Every writer in this
 * module takes it - {@link createTriggers}, {@link transitionTrigger} and
 * {@link markTriggersDelivered} - which is what makes the counter
 * race-free: each of them writes the WHOLE record from a snapshot read
 * inside the lock, so no pair of them can interleave and lose the other's
 * increment.
 */
export function recordRecurrence(record: TriggerRecord, now: Date): TriggerRecord {
  const next: TriggerRecord = Object.freeze({
    ...record,
    occurrences: record.occurrences + 1,
    lastSeenAt: now.toISOString(),
  });
  writeRecord(next);
  return next;
}

/**
 * Run one read-then-write pass over the trigger directory under its lock.
 *
 * Every writer here goes through this. Without it two callers (the CLI
 * and the MCP server can both reach the store) could each observe "no
 * twin" and persist duplicates for one cooldown key, and - because each
 * writer persists the WHOLE record, recurrence ledger included - a scan
 * interleaving with a transition or a brief delivery would silently drop
 * whichever increment landed first.
 */
function withTriggerDirLock<T>(vault: string, body: () => T): T {
  const dir = triggersDir(vault);
  mkdirSync(dir, { recursive: true });
  const release = lockfile.lockSync(dir, { stale: TRIGGER_LOCK_STALE_MS, realpath: false });
  try {
    return body();
  } finally {
    release();
  }
}

/** Persist candidates as triggers, skipping cooldown-blocked twins. */
export function createTriggers(
  vault: string,
  candidates: ReadonlyArray<InsightCandidate>,
  opts: CreateTriggersOptions,
): CreateTriggersResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  return withTriggerDirLock(vault, () => createTriggersLocked(vault, candidates, opts));
}

function createTriggersLocked(
  vault: string,
  candidates: ReadonlyArray<InsightCandidate>,
  opts: CreateTriggersOptions,
): CreateTriggersResult {
  const cooldownDays = opts.cooldownDays ?? TRIGGER_COOLDOWN_DAYS;
  const ttlDays = opts.ttlDays ?? TRIGGER_TTL_DAYS;
  const maxPerKind = opts.maxPerKind ?? TRIGGER_MAX_PER_KIND;
  const scan = readTriggers(vault, { now: opts.now });
  const byKey = new Map<string, TriggerRecord>();
  for (const record of scan.records) {
    // Newest record per key wins (list is newest-first, keep the first).
    if (!byKey.has(record.cooldownKey)) byKey.set(record.cooldownKey, record);
  }

  const created: TriggerRecord[] = [];
  const skipped: SkippedCandidate[] = [];
  const perKind = new Map<string, number>();
  const dir = triggersDir(vault);
  const createdAt = opts.now.toISOString();
  const expiresAt = new Date(opts.now.getTime() + ttlDays * DAY_MS).toISOString();
  const seenKeys = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.cooldownKey.trim() === "" || candidate.reason.trim() === "") {
      skipped.push({ cooldownKey: candidate.cooldownKey, reason: "invalid" });
      continue;
    }
    // One scan observing one finding twice is ONE occurrence, so the
    // duplicate is recognised before anything reaches the ledger -
    // whether or not a record already exists for the key.
    if (seenKeys.has(candidate.cooldownKey)) {
      skipped.push({ cooldownKey: candidate.cooldownKey, reason: "duplicate" });
      continue;
    }
    seenKeys.add(candidate.cooldownKey);
    const twin = byKey.get(candidate.cooldownKey);
    if (twin !== undefined) {
      const reason = blockReason(twin, opts.now, cooldownDays);
      if (reason !== null) {
        recordRecurrence(twin, opts.now);
        skipped.push({ cooldownKey: candidate.cooldownKey, reason });
        continue;
      }
    }
    const count = perKind.get(candidate.kind) ?? 0;
    if (count >= maxPerKind) {
      // The cap is a budget, not a judgement about the finding: it fired
      // and nothing surfaced, so when a record of it exists the ledger
      // gets the occurrence. When none does there is nothing to write to
      // and `skipped` is the whole report.
      if (twin !== undefined) recordRecurrence(twin, opts.now);
      skipped.push({ cooldownKey: candidate.cooldownKey, reason: "kind-cap" });
      continue;
    }
    perKind.set(candidate.kind, count + 1);

    const hash = createHash("sha256").update(candidate.cooldownKey).digest("hex").slice(0, 10);
    let id = `tr-${hash}-${createdAt.slice(0, 10)}`;
    let suffix = 2;
    while (existsSync(join(dir, `${id}${TRIGGER_FILE_EXT}`))) {
      id = `tr-${hash}-${createdAt.slice(0, 10)}-${suffix}`;
      suffix += 1;
    }
    const record: TriggerRecord = Object.freeze({
      ...candidate,
      id,
      status: TRIGGER_STATUS.pending,
      effectiveStatus: TRIGGER_STATUS.pending,
      createdAt,
      expiresAt,
      deliveredAt: null,
      resolvedAt: null,
      suppressedAt: null,
      suppressedFrom: null,
      // Creating the record IS the first recorded occurrence.
      occurrences: OCCURRENCES_WHEN_UNRECORDED,
      lastSeenAt: createdAt,
      path: join(dir, `${id}${TRIGGER_FILE_EXT}`),
    });
    writeRecord(record);
    created.push(record);
  }

  return Object.freeze({
    created: Object.freeze(created),
    skipped: Object.freeze(skipped),
    unreadable: scan.unreadable,
  });
}

// ── Transitions ─────────────────────────────────────────────────────────────

export type TriggerAction = "acknowledge" | "dismiss" | "act" | "suppress" | "unsuppress";

export interface TransitionOptions {
  readonly now: Date;
}

/**
 * Actions whose target status is fixed. `unsuppress` is absent because
 * its target is whatever status suppression interrupted, which is read
 * off the record rather than looked up here.
 */
/**
 * Refuse an id no readable record carries.
 *
 * When part of the queue is unreadable the refusal says so and names the
 * broken records: "no such trigger" would otherwise assert that the
 * finding is not there, when in truth the store could not look.
 */
function unknownTriggerError(id: string, unreadable: ReadonlyArray<UnreadableTrigger>): Error {
  if (unreadable.length === 0) return new Error(`unknown trigger: ${id}`);
  return new Error(
    `unknown trigger: ${id} - and ${unreadable.length} record(s) in the queue could not be read, ` +
      `so the id may belong to one of them: ${unreadable.map((u) => u.error.message).join("; ")}`,
  );
}

const ACTION_TO_STATUS: Record<Exclude<TriggerAction, "unsuppress">, TriggerStatus> = {
  acknowledge: TRIGGER_STATUS.acknowledged,
  dismiss: TRIGGER_STATUS.dismissed,
  act: TRIGGER_STATUS.acted,
  suppress: TRIGGER_STATUS.suppressed,
};

/**
 * Apply one lifecycle transition. Throws on an unknown id, on a terminal
 * state for acknowledge / dismiss / act, and on `unsuppress` against
 * anything that is not suppressed.
 *
 * An unreadable sibling never blocks the transition: the operator's way
 * out of a broken queue is to dismiss or suppress the records that still
 * read, so the target is looked up among those. It does colour the
 * unknown-id refusal, because the requested id may well belong to a
 * record nobody could parse and "unknown" alone would be a claim the
 * store cannot support.
 */
export function transitionTrigger(
  vault: string,
  id: string,
  action: TriggerAction,
  opts: TransitionOptions,
): TriggerRecord {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  return withTriggerDirLock(vault, () => transitionTriggerLocked(vault, id, action, opts));
}

function transitionTriggerLocked(
  vault: string,
  id: string,
  action: TriggerAction,
  opts: TransitionOptions,
): TriggerRecord {
  const scan = readTriggers(vault, { now: opts.now });
  const record = scan.records.find((r) => r.id === id);
  if (record === undefined) throw unknownTriggerError(id, scan.unreadable);
  const nowIso = opts.now.toISOString();

  if (action === "suppress") return suppress(record, nowIso);
  if (action === "unsuppress") return unsuppress(record, opts.now);

  if (TRIGGER_TERMINAL_STATUSES.has(record.effectiveStatus)) {
    throw new Error(`trigger ${id} is terminal (${record.effectiveStatus})`);
  }
  if (action === "acknowledge" && record.effectiveStatus === TRIGGER_STATUS.acknowledged) {
    return record; // idempotent
  }
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: ACTION_TO_STATUS[action],
    effectiveStatus: ACTION_TO_STATUS[action],
    resolvedAt: action === "acknowledge" ? record.resolvedAt : nowIso,
  });
  writeRecord(next);
  return next;
}

/**
 * Silence a cooldown key indefinitely.
 *
 * Legal from ANY status - "never surface this again" is a meaningful
 * judgement about an expired or already-acted finding too, because what
 * it silences is the key, not the record. The delivery and resolution
 * instants are deliberately left untouched: that is what makes
 * {@link unsuppress} an exact restore rather than a reconstruction.
 */
function suppress(record: TriggerRecord, nowIso: string): TriggerRecord {
  if (record.effectiveStatus === TRIGGER_STATUS.suppressed) return record; // idempotent
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: TRIGGER_STATUS.suppressed,
    effectiveStatus: TRIGGER_STATUS.suppressed,
    suppressedAt: nowIso,
    suppressedFrom: record.status,
  });
  writeRecord(next);
  return next;
}

/**
 * Undo a suppression, restoring the status it interrupted.
 *
 * The stored status is restored, not the effective one, so a trigger
 * suppressed while its TTL had already lapsed goes back to reading as
 * expired on the next read exactly as it did before.
 */
function unsuppress(record: TriggerRecord, now: Date): TriggerRecord {
  if (record.effectiveStatus !== TRIGGER_STATUS.suppressed) {
    throw new Error(`trigger ${record.id} is not suppressed (${record.effectiveStatus})`);
  }
  if (record.suppressedFrom === null) {
    // Never default to pending: that would invent a lifecycle position
    // and, for a formerly dismissed finding, silently restart its
    // cooldown from nothing.
    throw new Error(
      `trigger ${record.id} is suppressed but carries no suppressed_from; ` +
        "restore the field or dismiss the trigger instead",
    );
  }
  const restored = record.suppressedFrom;
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: restored,
    effectiveStatus: effectiveStatus(restored, record.expiresAt, now),
    suppressedAt: null,
    suppressedFrom: null,
  });
  writeRecord(next);
  return next;
}

/**
 * Stamp delivered_at + status=delivered on the given pending triggers.
 *
 * The ids come from a brief that has just been rendered, so they name
 * records that read cleanly; an unreadable sibling is irrelevant here and
 * must not deny the delivery stamp to the triggers the operator was in
 * fact shown.
 */
export function markTriggersDelivered(
  vault: string,
  ids: ReadonlyArray<string>,
  opts: TransitionOptions,
): void {
  if (ids.length === 0) return;
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  withTriggerDirLock(vault, () => markTriggersDeliveredLocked(vault, ids, opts));
}

function markTriggersDeliveredLocked(
  vault: string,
  ids: ReadonlyArray<string>,
  opts: TransitionOptions,
): void {
  const wanted = new Set(ids);
  const nowIso = opts.now.toISOString();
  for (const record of readTriggers(vault, { now: opts.now }).records) {
    if (!wanted.has(record.id)) continue;
    if (
      record.effectiveStatus !== TRIGGER_STATUS.pending &&
      record.effectiveStatus !== TRIGGER_STATUS.delivered
    ) {
      continue;
    }
    writeRecord(
      Object.freeze({
        ...record,
        status: TRIGGER_STATUS.delivered,
        effectiveStatus: TRIGGER_STATUS.delivered,
        deliveredAt: nowIso,
      }),
    );
  }
}

// ── Brief integration ───────────────────────────────────────────────────────

export interface BriefTriggersOptions {
  readonly now: Date;
  readonly cap: number;
  readonly cooldownDays: number;
}

const URGENCY_RANK: Record<string, number> = Object.fromEntries(
  TRIGGER_URGENCIES.map((u, i) => [u, i]),
);

/**
 * Triggers the morning brief may surface NOW: pending ones, plus
 * delivered-but-still-open ones whose last delivery is older than the
 * cooldown window. Ranked urgency desc, then newest first, capped.
 *
 * Eligibility is an allow-list of two statuses, so a suppressed trigger
 * is excluded by the same rule that excludes a dismissed one - no
 * suppression-specific branch exists or is needed here.
 *
 * Only readable records can be ranked, so an unreadable one is neither
 * surfaced nor allowed to empty the section. Naming it is the caller's
 * job: a brief surface reads {@link readTriggers} for
 * {@link TriggerScan.unreadable} and renders it with
 * {@link renderTriggerQueueFailures}, so an unreadable queue is never
 * shown as an empty one.
 */
export function briefTriggers(
  vault: string,
  opts: BriefTriggersOptions,
): ReadonlyArray<TriggerRecord> {
  const eligible = readTriggers(vault, { now: opts.now }).records.filter((record) => {
    if (record.effectiveStatus === TRIGGER_STATUS.pending) return true;
    if (record.effectiveStatus !== TRIGGER_STATUS.delivered) return false;
    const delivered = record.deliveredAt !== null ? Date.parse(record.deliveredAt) : Number.NaN;
    if (!Number.isFinite(delivered)) return true;
    return opts.now.getTime() >= delivered + opts.cooldownDays * DAY_MS;
  });
  const ranked = eligible.toSorted((a, b) => {
    const ur = (URGENCY_RANK[b.urgency] ?? 0) - (URGENCY_RANK[a.urgency] ?? 0);
    if (ur !== 0) return ur;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return Object.freeze(ranked.slice(0, Math.max(0, opts.cap)));
}
