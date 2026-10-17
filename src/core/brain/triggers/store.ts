/**
 * Trigger store with anti-nag lifecycle (Workspace Insight Suite,
 * t_cd1fee79).
 *
 * Each trigger is one Markdown file under `Brain/triggers/` - operator
 * readable without tooling, frontmatter carries the machine state.
 * History is a status change, not a file move: terminal triggers
 * (acted / dismissed / expired / suppressed / snoozed) stay in place so
 * `history` is just a status filter and the blocking logic can see them.
 *
 * Anti-nag invariants live here and only here:
 *   - cooldown-key dedup across ALL statuses makes repeated scans
 *     idempotent (a suppressed twin always blocks; an open twin always
 *     blocks; a dismissed twin blocks while no re-fire grounds the
 *     finding in anything its dismissal does not cover - movement, not
 *     the clock, is what resurrects it, read off the artifact set the
 *     candidate introduces AND a grounding fingerprint persisted at
 *     dismissal time, so the kinds whose cooldown key pins their own
 *     artifact ids are not dismissed into silence forever; an
 *     acted twin blocks for `cooldownDays` after its resolution; an
 *     expired twin allows);
 *   - lifecycle transitions: acknowledge / act / dismiss are allowed
 *     from ANY open state (an operator may act on a trigger they found
 *     via `list` before the brief ever delivered it - delivery is a
 *     surfacing step, not a gate), terminal states reject everything;
 *   - suppression is the one edge OUT of a terminal state: it is legal
 *     from any status, it carries no clock, and {@link transitionTrigger}
 *     restores the interrupted status verbatim on `unsuppress` because
 *     suppressing leaves the delivery and resolution instants untouched;
 *   - snooze is suppression's time-boxed sibling: it defers an open
 *     trigger for a bounded window OR until the finding's grounding
 *     moves since the snooze, whichever comes first (the early wake is
 *     the same movement gate the dismissal uses - a bare re-sighting of
 *     a still-true condition is not movement and never wakes it),
 *     and `unsnooze` wakes it by hand - the wake restores the
 *     interrupted status verbatim because snoozing leaves the delivery
 *     and resolution instants untouched;
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
/**
 * The snooze window in days: how long the `snooze` action defers an open
 * trigger. A constant, not a config key and not a caller option - the
 * snooze is the caller's estimate of "later", and grounding movement
 * wakes the trigger early regardless of the window (t_00e9de6a). Both
 * production surfaces pass `{ now }` only, so the option that once
 * carried this number was reachable from no surface and now lives here
 * alone, with the other knobs.
 */
export const TRIGGER_SNOOZE_DAYS = 3;
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
  dismissedFingerprint: "dismissed_fingerprint",
  snoozedAt: "snoozed_at",
  snoozedUntil: "snoozed_until",
  snoozedFrom: "snoozed_from",
  snoozedFingerprint: "snoozed_fingerprint",
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
    ...(record.dismissedFingerprint !== null
      ? [`${TRIGGER_KEY.dismissedFingerprint}: ${record.dismissedFingerprint}`]
      : []),
    ...(record.snoozedAt !== null ? [`${TRIGGER_KEY.snoozedAt}: ${record.snoozedAt}`] : []),
    ...(record.snoozedUntil !== null
      ? [`${TRIGGER_KEY.snoozedUntil}: ${record.snoozedUntil}`]
      : []),
    ...(record.snoozedFrom !== null ? [`${TRIGGER_KEY.snoozedFrom}: ${record.snoozedFrom}`] : []),
    ...(record.snoozedFingerprint !== null
      ? [`${TRIGGER_KEY.snoozedFingerprint}: ${record.snoozedFingerprint}`]
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
 * A recorded instant nobody was required to record, or `null`.
 *
 * The snooze instants are optional in the honest direction: absent means
 * nobody ever snoozed this record, which every reader below handles. A
 * PRESENT value that is not a readable instant refuses, exactly like
 * `last_seen_at` - the wake arithmetic compares these instants against
 * `now` and against each other, so a value it cannot read must stop the
 * record, not silently read as "never", which would strand a snoozed
 * finding forever while reporting it as merely deferred.
 */
function parseOptionalInstant(raw: unknown, key: string, path: string): string | null {
  if (raw === undefined) return null;
  const text = typeof raw === "string" ? raw : String(raw);
  if (text.length === 0 || Number.isNaN(Date.parse(text))) {
    throw new TriggerFieldError(path, key, presentButUnreadable("not a readable instant", raw));
  }
  return text;
}

/**
 * A persisted grounding fingerprint, or `null` when nothing recorded one.
 *
 * The fingerprints are optional in the honest direction: absent means the
 * record was dismissed or snoozed before the field existed, and every
 * reader treats that as "no baseline to compare against" - never as "the
 * grounding changed". A PRESENT value must read as the single hash string
 * the store writes; anything else refuses, because a fingerprint that
 * silently degraded to absent would retire the record's own movement
 * baseline while reporting the record as clean.
 */
function parseOptionalFingerprint(raw: unknown, key: string, path: string): string | null {
  if (raw === undefined) return null;
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new TriggerFieldError(path, key, presentButUnreadable("not a fingerprint hash", raw));
}

/**
 * The status a snooze interrupted, or `null` when nothing recorded one.
 *
 * Like {@link parseOptionalInstant}: absent is an honest `null`, present
 * but not a status refuses. A snoozed record whose interrupted status
 * cannot be read must not degrade to a snooze that can never wake into
 * anything - the wake arm would have nothing to restore.
 *
 * One present value refuses even though it IS a status: `snoozed`. A
 * snooze seeded from the computed status can never record it (see
 * {@link snooze}), so a file carrying it was hand-edited or predates the
 * write-site guard - and it describes a restore that restores into
 * itself. Read honestly it makes the record a permanent zombie: hidden
 * from `list` behind the terminal partition, refused by every
 * transition, undismissable. Rather than admit it silently, the read
 * boundary refuses and names the hand fix, so the record surfaces in
 * {@link TriggerScan.unreadable} next to its healthy siblings instead of
 * zombifying in silence.
 */
function parseSnoozedFrom(raw: unknown, path: string): TriggerStatus | null {
  if (raw === undefined) return null;
  if (typeof raw === "string" && isTriggerStatus(raw)) {
    if (raw === TRIGGER_STATUS.snoozed) {
      throw new TriggerFieldError(path, TRIGGER_KEY.snoozedFrom, restoreIntoItself(raw));
    }
    return raw;
  }
  throw new TriggerFieldError(
    path,
    TRIGGER_KEY.snoozedFrom,
    presentButUnreadable(`not one of ${TRIGGER_STATUSES.join(", ")}`, raw),
  );
}

/**
 * The status a suppression interrupted, or `null` when nothing recorded
 * one.
 *
 * The twin of {@link parseSnoozedFrom}: absent is an honest `null`,
 * present but not a status refuses rather than degrading to `null` (which
 * would read a hand-edited record as one that never carried a prior
 * status), and `suppressed` refuses as the restore-into-itself zombie it
 * is - a suppression carrying it can never be undone into anything but
 * itself.
 */
function parseSuppressedFrom(raw: unknown, path: string): TriggerStatus | null {
  if (raw === undefined) return null;
  if (typeof raw === "string" && isTriggerStatus(raw)) {
    if (raw === TRIGGER_STATUS.suppressed) {
      throw new TriggerFieldError(path, TRIGGER_KEY.suppressedFrom, restoreIntoItself(raw));
    }
    return raw;
  }
  throw new TriggerFieldError(
    path,
    TRIGGER_KEY.suppressedFrom,
    presentButUnreadable(`not one of ${TRIGGER_STATUSES.join(", ")}`, raw),
  );
}

/**
 * Detail for a restore-from field naming its own status class. The value
 * is a real status, so the ordinary vocabulary refusal would pass it; the
 * remedy it names is the hand fix - never `dismiss`, which is exactly the
 * transition a record this broken is refused.
 */
function restoreIntoItself(value: TriggerStatus): string {
  return (
    `reads '${value}', which would restore a ${value} record into itself - ` +
    "a zombie hidden from list and refused by every transition; " +
    "fix the field by hand to the status the silence interrupted"
  );
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

/**
 * The fields the snooze wake arm reads: when the snooze window ends, and
 * the status it interrupted. {@link TriggerRecord} satisfies it.
 */
interface SnoozeLedger {
  readonly snoozedUntil: string | null;
  readonly snoozedFrom: TriggerStatus | null;
}

/**
 * The status a finished snooze restores, or `null` while it still holds.
 *
 * The CLOCK half of the wake condition: the window end. The other half -
 * the early wake - is a movement judgement ("the finding's grounding
 * moved since the snooze"), and a read-time arm cannot make it: at read
 * time there is no candidate to compare against, and the recurrence
 * ledger it used to read (`lastSeenAt > snoozedAt`) records a bare
 * re-sighting, which is not movement - the detectors report state, so a
 * still-true condition re-fires on EVERY scan and any scan wakes the
 * snooze within minutes. The early wake therefore lives where the
 * candidate is: {@link createTriggersLocked} wakes a snoozed twin whose
 * re-fire introduces grounding the snooze does not cover, and this arm
 * wakes by the window alone. A record missing the window never wakes by
 * the clock - no window means no clock to elapse. That is the
 * neutral-absence reading, not a defaulted one: the store always writes
 * it, so only a hand-edited record lacks it.
 */
function snoozeWoken(ledger: SnoozeLedger, now: Date): TriggerStatus | null {
  if (ledger.snoozedFrom === null) return null;
  const until = ledger.snoozedUntil !== null ? Date.parse(ledger.snoozedUntil) : Number.NaN;
  return Number.isFinite(until) && now.getTime() > until ? ledger.snoozedFrom : null;
}

function effectiveStatus(
  status: TriggerStatus,
  expiresAt: string,
  now: Date,
  ledger: SnoozeLedger,
): TriggerStatus {
  // The snooze wake: a snoozed record reads as the status its snooze
  // interrupted once the window ends; grounding movement wakes it early
  // at the scan site instead, where the candidate is available to
  // compare against ({@link createTriggersLocked}). Like expiry below
  // this is a read-time computation - the file keeps its stored status -
  // and the restored status is open by construction, because `snooze`
  // is legal from open states only.
  let current = status;
  if (current === TRIGGER_STATUS.snoozed) {
    const restored = snoozeWoken(ledger, now);
    if (restored === null) return current;
    current = restored;
  }
  // Expiry applies to open statuses only, which is precisely what makes
  // `suppressed` indefinite: it is terminal, so no clock reaches it -
  // and a snoozed record is governed by its snooze window, not by the
  // TTL clock, because the wake above runs first.
  if (!TRIGGER_OPEN_STATUSES.has(current)) return current;
  const expiry = Date.parse(expiresAt);
  if (Number.isFinite(expiry) && now.getTime() > expiry) return "expired";
  return current;
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
  const suppressedFrom = parseSuppressedFrom(meta[TRIGGER_KEY.suppressedFrom], path);
  const dismissedFingerprint = parseOptionalFingerprint(
    meta[TRIGGER_KEY.dismissedFingerprint],
    TRIGGER_KEY.dismissedFingerprint,
    path,
  );
  const snoozedAt = parseOptionalInstant(meta[TRIGGER_KEY.snoozedAt], TRIGGER_KEY.snoozedAt, path);
  const snoozedUntil = parseOptionalInstant(
    meta[TRIGGER_KEY.snoozedUntil],
    TRIGGER_KEY.snoozedUntil,
    path,
  );
  const snoozedFrom = parseSnoozedFrom(meta[TRIGGER_KEY.snoozedFrom], path);
  const snoozedFingerprint = parseOptionalFingerprint(
    meta[TRIGGER_KEY.snoozedFingerprint],
    TRIGGER_KEY.snoozedFingerprint,
    path,
  );
  const lastSeenAt = parseLastSeenAt(meta[TRIGGER_KEY.lastSeenAt], createdAt, path);
  return Object.freeze({
    id,
    kind,
    status,
    effectiveStatus: effectiveStatus(status, expiresAt, now, {
      snoozedUntil,
      snoozedFrom,
    }),
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
    suppressedFrom,
    dismissedFingerprint,
    snoozedAt,
    snoozedUntil,
    snoozedFrom,
    snoozedFingerprint,
    occurrences: parseOccurrences(meta[TRIGGER_KEY.occurrences], path),
    lastSeenAt,
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
  /**
   * Days an acted twin blocks recreation. A DISMISSED twin is not on
   * this clock: it blocks while no re-fire introduces grounding the
   * dismissal does not cover, however long, and moves aside the moment
   * a re-fire arrives on changed ones (t_00e9de6a).
   */
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
 * `active` / `cooldown` / `suppressed` / `snoozed` / `dismissed` - an
 *   existing record blocked it, and that record's ledger records the
 *   recurrence.
 * `kind-cap` - the per-kind budget for this scan was already spent.
 */
export interface SkippedCandidate {
  readonly cooldownKey: string;
  readonly reason:
    | "active"
    | "cooldown"
    | "duplicate"
    | "kind-cap"
    | "invalid"
    | "suppressed"
    | "snoozed"
    | "dismissed";
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

/**
 * Whether a re-fire arrived on grounding the dismissal does not cover.
 *
 * Movement is the candidate INTRODUCING an artifact absent from the
 * persisted set: the finding now rests on something the dismissal never
 * saw, so it no longer covers it. The comparison is set-based, in the
 * `deriveDatasetHash` convention inlined
 * (src/core/brain/derived-artifact.ts): both sides deduplicated, so it
 * is order-insensitive and duplicate-insensitive by construction - the
 * detector firing on the same artifacts in a different walk order is not
 * movement, and neither is a re-fire naming a SUBSET of the persisted
 * grounding. A remote `brain_trigger scan` that sees less than the
 * original one introduces nothing new, and a dismissal is undone only by
 * new evidence, not by a narrower sighting of the same one.
 *
 * An EMPTY persisted list never reads as moved, whatever the candidate
 * names: absence of grounding is the neutral reading (the content-hash
 * convention - absent reads as no-drift), so a record written before the
 * key existed stays dismissed rather than resurrecting on a comparison
 * it cannot support. The store always writes the list, so only a
 * hand-edited or legacy record lacks it.
 */
function sourceArtifactsChanged(
  persisted: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
): boolean {
  if (persisted.length === 0) return false;
  const covered = new Set(persisted);
  return [...new Set(current)].some((artifact) => !covered.has(artifact));
}

/**
 * Digit runs that are NOT the date of an ISO-8601 instant. The alternation
 * is ordered so a date matches first and survives verbatim, while every
 * other digit run is normalized away.
 */
const CLOCK_PROJECTED_DIGITS = /(\d{4}-\d{2}-\d{2})|\d+/gu;

/**
 * Read a grounding text with its clock projections normalized away.
 *
 * The producers embed the clock in their findings: the stale-claim reason
 * carries a day count that grows every scan, the idea reasons carry ages
 * and age-derived scores, and a dismissed record's own Reason section
 * carries the day count frozen at its creation. A fingerprint of the raw
 * text would therefore differ on the first day boundary after the
 * silence even though nothing about the finding moved - the clock, not
 * the content, resurrecting a silenced finding, which is exactly the nag
 * the movement gate exists to replace. Day counts, ages and scores are
 * the clock speaking; dates and identifiers are the content. This keeps
 * the dates (a re-evidenced preference carries a new evidence date) and
 * masks every other digit run, so a bare re-sight of untouched grounding
 * hashes the same at any age.
 */
function normalizeGroundingText(text: string): string {
  return text.replace(CLOCK_PROJECTED_DIGITS, (match, iso: string | undefined) =>
    iso !== undefined ? iso : "#",
  );
}

/**
 * A content fingerprint of a finding's grounding: its reason and context
 * snippets, clock-normalized, hashed with field-tagged separators so no
 * pair of different groundings collides across boundaries.
 *
 * This is the second arm of the movement gate. The first - the artifact
 * set - can never move for the kinds whose cooldown key is built from
 * their own artifact ids (`stale_claim:<id>` grounds itself in `[[<id>]]`
 * alone), so without it a dismissal of those kinds is permanent. The
 * fingerprint changes when the grounding's CONTENT changes - a preference
 * re-evidenced, a contradicting pair rewritten - and stays put when only
 * the clock moved, which is what makes it a movement signal and not a
 * cooldown.
 */
function groundingFingerprintOf(reason: string, contextSnippets: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  hash.update("reason\n" + normalizeGroundingText(reason));
  for (const snippet of contextSnippets) {
    hash.update("context\n" + normalizeGroundingText(snippet));
  }
  return hash.digest("hex");
}

/**
 * Whether a re-fire arrived on grounding the persisted silence does not
 * cover - the one movement gate both silenced classes read.
 *
 * Movement is the candidate INTRODUCING an artifact the persisted set
 * lacks ({@link sourceArtifactsChanged}) or grounding the finding in
 * content the persisted fingerprint does not cover. A persisted
 * fingerprint of `null` - a record written before the field existed, or
 * a hand-edited one - leaves the fingerprint arm silent: absence of a
 * baseline can never read as movement, the same neutral reading the
 * artifact arm gives an empty persisted list, so legacy records behave
 * exactly as they did and only ever move by their artifacts.
 */
function groundingMoved(
  persistedArtifacts: ReadonlyArray<string>,
  candidateArtifacts: ReadonlyArray<string>,
  persistedFingerprint: string | null,
  candidateFingerprint: string,
): boolean {
  if (sourceArtifactsChanged(persistedArtifacts, candidateArtifacts)) return true;
  return persistedFingerprint !== null && persistedFingerprint !== candidateFingerprint;
}

/**
 * The cooldown key a batch sighting resolves to, given what is persisted.
 *
 * One kind's key is derived from an OBSERVED SET rather than a fixed
 * identity: `batch_inflation` names the burst's first and last observed
 * member, so a scan at narrower reach - which sees a subset of the
 * burst's records - derives a different key for the SAME finding. The
 * key must be reach-stable, and the only reach-stable quantity available
 * to the narrowed scan is the persisted record itself: when a batch
 * candidate grounds itself entirely in artifacts a persisted batch record
 * already covers - a narrowed sighting of the same burst - it resolves to
 * THAT record's cooldown key, and the ordinary movement gate decides from
 * there. A sighting that introduces an artifact the record never saw is
 * movement and keeps its own key; a record with no persisted grounding
 * covers nothing, the same neutral reading
 * {@link sourceArtifactsChanged} gives absence.
 *
 * This is the key-layer half of the dismissed-movement invariant: without
 * it, a suppressed or dismissed twin is bypassed not by movement and not
 * by the clock, but by a renamed key.
 */
function resolveBatchSightingKey(
  candidate: InsightCandidate,
  persisted: ReadonlyArray<{ readonly key: string; readonly covered: ReadonlySet<string> }>,
): string {
  if (candidate.kind !== "batch_inflation") return candidate.cooldownKey;
  if (candidate.sourceArtifacts.length === 0) return candidate.cooldownKey;
  for (const record of persisted) {
    if (candidate.sourceArtifacts.every((artifact) => record.covered.has(artifact))) {
      return record.key;
    }
  }
  return candidate.cooldownKey;
}

function blockReason(
  twin: TriggerRecord,
  now: Date,
  cooldownDays: number,
  candidateArtifacts: ReadonlyArray<string>,
  candidateFingerprint: string,
): SkippedCandidate["reason"] | null {
  // Suppression comes first and carries no clock: the operator judged
  // this cooldown key structurally benign, so no arithmetic below can
  // ever let it back through.
  if (twin.effectiveStatus === TRIGGER_STATUS.suppressed) return "suppressed";
  // A snoozed twin blocks too, and MUST: the recurrence this write
  // records is what keeps a still-true finding auditable while the
  // window runs ({@link recordRecurrence}). The early wake is not
  // decided here - a bare re-sighting must not wake the snooze, and
  // only the scan site holds the candidate a movement judgement needs -
  // so a snoozed twin always reports snoozed, and
  // {@link wakeSnoozedOnMovement} has already done the waking for the
  // sightings that did move.
  if (twin.effectiveStatus === TRIGGER_STATUS.snoozed) return "snoozed";
  if (TRIGGER_OPEN_STATUSES.has(twin.effectiveStatus)) return "active";
  if (twin.effectiveStatus === TRIGGER_STATUS.expired) return null;
  // dismissed: movement-gated. The finding stays silent while no
  // re-fire grounds it in anything the dismissal does not cover, and is
  // recreated - as a new record through the normal path - the moment a
  // re-fire introduces an artifact the dismissal never saw or grounds
  // the finding in content the dismissal-time fingerprint does not
  // cover. The fingerprint is what gives the four kinds whose cooldown
  // key pins their own artifact ids a movement signal at all: for them
  // the artifact set can never change, and without it a dismissal is a
  // permanent suppress. No clock: the old cooldown window could
  // resurrect an untouched finding and keep a moved one silent, which
  // is exactly the nag this gate replaces.
  if (twin.effectiveStatus === TRIGGER_STATUS.dismissed) {
    return groundingMoved(
      twin.sourceArtifacts,
      candidateArtifacts,
      twin.dismissedFingerprint,
      candidateFingerprint,
    )
      ? null
      : "dismissed";
  }
  // acted: the plain cooldown window after the resolution instant.
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
 * Wake a snoozed record whose re-fire arrived on grounding the snooze
 * does not cover; return the record unchanged when the sighting moved
 * nothing.
 *
 * This is the early wake, and it lives at the scan site because movement
 * is a judgement ABOUT A CANDIDATE: the detectors report state, so a
 * still-true condition re-fires on every scan and every scan stamps the
 * recurrence ledger - the `lastSeenAt > snoozedAt` read this used to
 * wake on treated any rescan as a refire and ended the snooze within
 * minutes. A bare re-sighting leaves the snooze holding; one that
 * introduces an artifact the record never saw, or grounds the finding in
 * content its snooze-time fingerprint does not cover
 * ({@link groundingMoved}), wakes the record IN PLACE: the exact status
 * the snooze interrupted is restored, the snooze state is cleared, and
 * the waking scan goes on to meet an open twin rather than a duplicate.
 *
 * A record carrying no restore status never wakes - the neutral reading
 * {@link snoozeWoken} gives the same absence at the clock arm.
 */
function wakeSnoozedOnMovement(
  twin: TriggerRecord,
  candidate: InsightCandidate,
  candidateFingerprint: string,
  now: Date,
): TriggerRecord {
  if (twin.snoozedFrom === null) return twin;
  const moved = groundingMoved(
    twin.sourceArtifacts,
    candidate.sourceArtifacts,
    twin.snoozedFingerprint,
    candidateFingerprint,
  );
  return moved ? wakeSnoozed(twin, now) : twin;
}

/**
 * Restore a snoozed record to the status its snooze interrupted and
 * clear the snooze state, fingerprint included - the wake hands back the
 * record as it was before the pause, so a later snooze baselines a later
 * grounding. Expiry is re-applied on the computed status, the
 * {@link unsnooze} precedent.
 */
function wakeSnoozed(record: TriggerRecord, now: Date): TriggerRecord {
  const restored = record.snoozedFrom;
  if (restored === null) {
    // Unreachable through both callers: {@link unsnooze} refuses such a
    // record at its guard, and {@link wakeSnoozedOnMovement} returns
    // early. Guarded here so the invariant holds at the only place the
    // wake is written.
    throw new Error(`trigger ${record.id} is snoozed but carries no snoozed_from`);
  }
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: restored,
    effectiveStatus: effectiveStatus(restored, record.expiresAt, now, {
      snoozedUntil: null,
      snoozedFrom: null,
    }),
    snoozedAt: null,
    snoozedUntil: null,
    snoozedFrom: null,
    snoozedFingerprint: null,
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
  // Persisted batch records, newest first, as coverage sets for the
  // reach-stable key resolution below.
  const persistedBatches = scan.records
    .filter((record) => record.kind === "batch_inflation" && record.sourceArtifacts.length > 0)
    .map((record) => ({ key: record.cooldownKey, covered: new Set(record.sourceArtifacts) }));

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
    // The key the candidate resolves to: its own, or - for a batch
    // sighting a persisted record already covers - the persisted
    // record's own key, so a narrowed scan cannot rename a finding out
    // from under its twin.
    const key = resolveBatchSightingKey(candidate, persistedBatches);
    // One scan observing one finding twice is ONE occurrence, so the
    // duplicate is recognised before anything reaches the ledger -
    // whether or not a record already exists for the key.
    if (seenKeys.has(key)) {
      skipped.push({ cooldownKey: key, reason: "duplicate" });
      continue;
    }
    seenKeys.add(key);
    let twin = byKey.get(key);
    if (twin !== undefined) {
      // The sighting's grounding fingerprint, computed once for both
      // movement readers below: the snooze wake (which can rewrite the
      // twin in place) and the dismissed gate.
      const sighting = groundingFingerprintOf(candidate.reason, candidate.contextSnippets);
      if (twin.effectiveStatus === TRIGGER_STATUS.snoozed) {
        twin = wakeSnoozedOnMovement(twin, candidate, sighting, opts.now);
      }
      const reason = blockReason(twin, opts.now, cooldownDays, candidate.sourceArtifacts, sighting);
      if (reason !== null) {
        recordRecurrence(twin, opts.now);
        skipped.push({ cooldownKey: key, reason });
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
      skipped.push({ cooldownKey: key, reason: "kind-cap" });
      continue;
    }
    perKind.set(candidate.kind, count + 1);

    const hash = createHash("sha256").update(key).digest("hex").slice(0, 10);
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
      // The resolved key, so a batch created past an expired twin carries
      // the identity the next sighting will resolve to.
      cooldownKey: key,
      createdAt,
      expiresAt,
      deliveredAt: null,
      resolvedAt: null,
      suppressedAt: null,
      suppressedFrom: null,
      dismissedFingerprint: null,
      snoozedAt: null,
      snoozedUntil: null,
      snoozedFrom: null,
      snoozedFingerprint: null,
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

/**
 * Every lifecycle action, in one runtime list: the CLI verb map and the
 * MCP transition list mirror it, and the surface-exhaustiveness test
 * reads it, so a new action cannot land on one surface alone.
 */
export const TRIGGER_ACTIONS = Object.freeze([
  "acknowledge",
  "dismiss",
  "act",
  "suppress",
  "unsuppress",
  "snooze",
  "unsnooze",
] as const);

export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

/**
 * What every lifecycle transition and the delivery stamp are given: the
 * instant they run at. Deliberately nothing else - the snooze window in
 * particular is {@link TRIGGER_SNOOZE_DAYS}, a constant beside the other
 * knobs, not a caller option: both production surfaces pass `{ now }`
 * only, so an option here was reachable from no surface.
 */
export interface TransitionOptions {
  readonly now: Date;
}

/**
 * Actions whose target status is fixed. `unsuppress` and `unsnooze` are
 * absent because their targets are whatever status the silence
 * interrupted, which is read off the record rather than looked up here.
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

const ACTION_TO_STATUS: Record<Exclude<TriggerAction, "unsuppress" | "unsnooze">, TriggerStatus> = {
  acknowledge: TRIGGER_STATUS.acknowledged,
  dismiss: TRIGGER_STATUS.dismissed,
  act: TRIGGER_STATUS.acted,
  suppress: TRIGGER_STATUS.suppressed,
  snooze: TRIGGER_STATUS.snoozed,
};

/**
 * Apply one lifecycle transition. Throws on an unknown id, on a terminal
 * state for acknowledge / dismiss / act / snooze, on `unsuppress`
 * against anything that is not suppressed, and on `unsnooze` against
 * anything that is not snoozed.
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
  if (action === "unsnooze") return unsnooze(record, opts.now);

  // Snooze is legal from open states only, so it sits behind the same
  // terminal check as acknowledge / dismiss / act - which is also what
  // makes the refusal text name a snoozed state correctly on a
  // re-snooze instead of treating one as idempotent.
  if (TRIGGER_TERMINAL_STATUSES.has(record.effectiveStatus)) {
    throw new Error(`trigger ${id} is terminal (${record.effectiveStatus})`);
  }
  if (action === "snooze") {
    return snooze(record, opts.now);
  }
  if (action === "acknowledge" && record.effectiveStatus === TRIGGER_STATUS.acknowledged) {
    return record; // idempotent
  }
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: ACTION_TO_STATUS[action],
    effectiveStatus: ACTION_TO_STATUS[action],
    resolvedAt: action === "acknowledge" ? record.resolvedAt : nowIso,
    // The dismissal persists the grounding it covered, so a later
    // re-fire can be judged against it ({@link blockReason}). The
    // record's own reason and context ARE the grounding it was created
    // from - the same fields a candidate carries.
    ...(action === "dismiss"
      ? { dismissedFingerprint: groundingFingerprintOf(record.reason, record.contextSnippets) }
      : {}),
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
    // cooldown from nothing. The remedy is the hand fix, and only the
    // hand fix - this record is terminal, so every transition including
    // dismiss is refused and advertising one would strand the operator.
    throw new Error(
      `trigger ${record.id} is suppressed but carries no suppressed_from; ` +
        "restore the field by hand - set suppressed_from to the status the suppression interrupted, " +
        "or edit the status line off suppressed directly",
    );
  }
  const restored = record.suppressedFrom;
  // A suppression never restores INTO suppressed, mirroring the snooze
  // write-site guard below. {@link parseSuppressedFrom} refuses such a
  // file at the read boundary, so this arm guards the in-memory path only;
  // enforced here so the invariant holds at every place the field is read.
  if (restored === TRIGGER_STATUS.suppressed) {
    throw new Error(
      `trigger ${record.id} carries suppressed_from: suppressed; ` +
        "a suppression cannot restore into suppressed",
    );
  }
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: restored,
    effectiveStatus: effectiveStatus(restored, record.expiresAt, now, record),
    suppressedAt: null,
    suppressedFrom: null,
  });
  writeRecord(next);
  return next;
}

/**
 * Defer an open trigger for a bounded window, or until its grounding
 * moves.
 *
 * The snooze is a pause, not a resolution: `resolvedAt` and the delivery
 * ledger are untouched, so what the window ends - or grounding movement
 * wakes early ({@link wakeSnoozedOnMovement}) - is the exact status that
 * was interrupted. Legal from open states only; the transition refuses
 * it on anything terminal, snoozed included, so re-snoozing goes through
 * an explicit {@link unsnooze} or a movement wake first.
 */
function snooze(record: TriggerRecord, now: Date): TriggerRecord {
  // The interrupted status is seeded from the COMPUTED status, not the
  // stored one. They usually agree - a live snooze is stored snoozed -
  // but a CLOCK-WOKEN record is stored snoozed while computing the open
  // status its elapsed window interrupted, and seeding from the file
  // would write `snoozed_from: snoozed`: a snooze that restores INTO
  // snoozed. The next wake would then read snoozed again, the record
  // would hide from `list`, refuse every transition, and re-poison
  // itself on `unsnooze` - the bounded deferral become an indefinite
  // silent kill.
  const interrupted = record.effectiveStatus;
  if (interrupted === TRIGGER_STATUS.snoozed) {
    // A snooze never restores INTO snoozed. Unreachable through
    // {@link transitionTrigger}, whose terminal check refuses a record
    // still reading as snoozed first; enforced here so the invariant
    // holds at the only place that writes the field.
    throw new Error(
      `trigger ${record.id} is already snoozed; a snooze cannot restore into snoozed`,
    );
  }
  const next: TriggerRecord = Object.freeze({
    ...record,
    status: TRIGGER_STATUS.snoozed,
    effectiveStatus: TRIGGER_STATUS.snoozed,
    snoozedAt: now.toISOString(),
    snoozedUntil: new Date(now.getTime() + TRIGGER_SNOOZE_DAYS * DAY_MS).toISOString(),
    snoozedFrom: interrupted,
    // The grounding baseline the early wake reads: a re-fire must move
    // past this fingerprint (or introduce a new artifact) to wake the
    // snooze before its window ends.
    snoozedFingerprint: groundingFingerprintOf(record.reason, record.contextSnippets),
  });
  writeRecord(next);
  return next;
}

/**
 * Wake a snoozed trigger by hand, restoring the status the snooze
 * interrupted before its window ends.
 *
 * The stored status is restored, not the effective one, and expiry is
 * re-applied on the next read - the {@link unsuppress} precedent, so a
 * trigger snoozed past its TTL wakes reading as expired exactly as an
 * unsuppressed one would.
 */
function unsnooze(record: TriggerRecord, now: Date): TriggerRecord {
  if (record.effectiveStatus !== TRIGGER_STATUS.snoozed) {
    throw new Error(`trigger ${record.id} is not snoozed (${record.effectiveStatus})`);
  }
  if (record.snoozedFrom === null) {
    // Never default to pending: that would invent a lifecycle position
    // the record does not carry. The remedy is the hand fix, and only
    // the hand fix - this record is terminal, so every transition
    // including dismiss is refused and advertising one would strand the
    // operator.
    throw new Error(
      `trigger ${record.id} is snoozed but carries no snoozed_from; ` +
        "restore the field by hand - set snoozed_from to the status the snooze interrupted, " +
        "or edit the status line off snoozed directly",
    );
  }
  const restored = record.snoozedFrom;
  // A snooze never restores INTO snoozed, mirroring the {@link snooze}
  // write-site guard. {@link parseSnoozedFrom} refuses such a file at the
  // read boundary, so this arm guards the in-memory path only; enforced
  // here so the invariant holds at every place the field is read.
  if (restored === TRIGGER_STATUS.snoozed) {
    throw new Error(
      `trigger ${record.id} carries snoozed_from: snoozed; ` +
        "a snooze cannot restore into snoozed",
    );
  }
  return wakeSnoozed(record, now);
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
