/**
 * Cross-agent log catch-up cursor state (t_3b44cd9a).
 *
 * One overwrite-only file per reading identity,
 * `<vault>/.open-second-brain/log-catchup.<identity>-<digest>.cursor.json`,
 * holding the watermark of what the catch-up lane last showed THAT
 * identity on this device: the `(date, shardId, line)` merge-order
 * position of the last entry seen, plus the per-shard high-water line
 * marks for that date. Vault-local and un-synced derived state, beside
 * `backlog-nudge.count` and for the same reasons: the watermark belongs
 * to this device's reading progress, so syncing it would make devices
 * fight over each other's cursors, and per-session hook-state is the
 * wrong lifetime for "since my last look".
 *
 * WHY PER IDENTITY. Several runtimes (claude/codex/grok) share one
 * device and one vault while carrying different `VAULT_AGENT_NAME`s. A
 * single vault-wide file would let whichever runtime runs first advance
 * the watermark past lines the others never saw - each identity reads
 * the log through its own self-filter, so "last look" is a fact about
 * the identity, not about the device. The identity is sanitized into
 * the file name (`[^A-Za-z0-9._-]` -> `_`, plus a short digest of the
 * raw name so the sanitization stays one-to-one) because a configured
 * agent name is arbitrary operator input and the file name must stay
 * inside the derived store.
 *
 * WHY THE PRE-IDENTITY FILE IS NOT MIGRATED. The old un-namespaced
 * `log-catchup.cursor.json` recorded what SOME identity on this device
 * last saw, with no record of which - adopting it could hide lines from
 * the identity now asking, which is the one failure this lane cannot
 * take. So an existing legacy file is simply never read: every identity
 * starts fresh and replays history once under the lane's caps (bounded,
 * fail-open) rather than risk that silence. The file is left in place;
 * nothing reads it again.
 *
 * The digest in the file name ships the same refusal one step further:
 * the digest-less per-identity name this module briefly wrote
 * (`log-catchup.<identity>.cursor.json`) is orphaned by the rename, and
 * the older files are never read either. A migration would be derivable
 * there - the digest computes from the identity - but it would keep a
 * second file-name rule alive forever, and the reset is cheap: one
 * replay of history under the lane's caps on the first run after the
 * upgrade, after which the orphan sits unread in the derived store.
 *
 * WHY THE PER-SHARD MARKS BESIDE THE TUPLE. `readLogDay` merges a day's
 * shards sorted by (timestamp, shardId, line), so a new line appended to
 * a LOW-named shard sorts BEFORE the high-water tuple even though it is
 * newer; and a shard that first appears mid-date has lines below any line
 * the tuple could name. The tuple is the human-readable merge-order
 * position; the `shards` map is the instrument the filter reads: on the
 * cursor date an entry is new when its shard has no mark yet or its line
 * index is past that shard's mark. Appends only ever extend a shard
 * file, so a mark never needs retraction.
 *
 * Fail-soft on both sides, mirroring the backlog-nudge convention: a
 * missing, unreadable, non-regular or corrupt file reads as `null` (the
 * next session replays history under the lane's caps rather than staying
 * silent forever), and a write reports `false` instead of throwing so
 * the hook's silent-exit-0 contract holds.
 *
 * Import-light on purpose (node:crypto and node:fs builtins, the atomic
 * writer, the no-follow guard, the path constant), so the hook can
 * statically import it and stay cheap when the feature flag is off.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { DERIVED_STORE_DIR } from "../../src/core/brain/path-constants.ts";
import {
  derivedDirIsSymlinked,
  readRegularFileNoFollow,
} from "../../src/core/derived-store-guard.ts";
import { atomicWriteText } from "../../src/core/fs-atomic.ts";

/** Stem of the per-identity state file, under {@link DERIVED_STORE_DIR}. */
export const LOG_CATCHUP_CURSOR_STEM = "log-catchup";

/**
 * The per-identity state file name, directly under
 * {@link DERIVED_STORE_DIR}: `log-catchup.<identity>-<digest>.cursor.json`
 * where `<identity>` is the raw name with every character outside
 * `[A-Za-z0-9._-]` replaced by `_` - so a hostile or exotic agent name
 * cannot escape the derived store - and `<digest>` is the first 8 hex of
 * the raw name's sha-256. The digest is what keeps the mapping one-to-one:
 * the replacement alone is not (`agent b`, `agent/b` and `agent_b` all
 * sanitize to `agent_b`), and two identities sharing one file would read
 * and park each other's watermark.
 */
export function logCatchupCursorFilename(identity: string): string {
  const sanitized = identity.replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 8);
  return `${LOG_CATCHUP_CURSOR_STEM}.${sanitized}-${digest}.cursor.json`;
}

/**
 * How many dates on either side of {@link LogCatchupCursor.date} keep
 * their per-shard marks: the `days` map holds at most this many dates
 * strictly OLDER than the cursor date, the `future` map at most this many
 * dates strictly NEWER. Delayed cross-device sync is the normal case, so
 * yesterday's late-arriving shard must still be readable per (date,
 * shard); the bounds keep the file small no matter how far back the log
 * goes or how far into the future a skewed writer stamps.
 */
export const LOG_CATCHUP_WINDOW_DATES = 3;

/**
 * A calendar cutoff `windowDates` behind `referenceDate` (UTC, date
 * strings all the way through): the shared arithmetic behind the catch-up
 * lane's cursor window skip and the first-run window below. Lives here
 * beside the window constant so the lane's date bounds have one home -
 * and so the pure helpers the tests read import without the hook
 * entry's run-at-import process body.
 */
export function dateCutoff(referenceDate: string, windowDates: number): string {
  const d = new Date(`${referenceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - windowDates);
  return d.toISOString().slice(0, 10);
}

/**
 * How far back a FIRST run (no cursor yet) of the catch-up lane scans:
 * the cursor window plus two days of slack. A first run has no marks to
 * vouch about anything, and without a bound it would parse the WHOLE
 * history - on a vault with years of daily log, every SessionStart of a
 * new identity read every day only to render the newest lines. Two days
 * beyond the cursor window keep the first run's reach a superset of what
 * a parked cursor would still rescan, so the hand-off from "no cursor"
 * to "parked cursor" never narrows what a late-synced shard can surface
 * in.
 */
export const LOG_CATCHUP_FIRST_RUN_WINDOW_DATES = LOG_CATCHUP_WINDOW_DATES + 2;

/**
 * The oldest date a no-cursor catch-up run still scans: the first-run
 * window behind the NEWEST date in the log that is today or earlier (not
 * behind today itself - a vault whose newest entry is months old should
 * still catch up on its own recent tail, not report all of it
 * unscanned). The clamp to real dates is the watermark parking clamp
 * again: a clock-skewed writer's future date is newest in merge order
 * but must not widen the window past every real day - referenced on the
 * skew, the window would call ALL of today's history unscanned. When
 * every date is future the reference falls back to today, so the skew
 * lines still surface while nothing real is miscounted. `dates` must be
 * sorted, as the derived date list is; null when the log has no dates
 * at all. Dates older than the cutoff are counted and reported, never
 * parsed.
 */
export function firstRunScanCutoffDate(dates: ReadonlyArray<string>, today: string): string | null {
  if (dates.length === 0) return null;
  const real = dates.filter((d) => d <= today);
  const reference = real.length > 0 ? real[real.length - 1]! : today;
  return dateCutoff(reference, LOG_CATCHUP_FIRST_RUN_WINDOW_DATES);
}

/**
 * The watermark: the merge-order position of the last entry seen on
 * {@link date}, plus the per-shard high-water line marks (0-based
 * indexes) for that date, plus at most {@link LOG_CATCHUP_WINDOW_DATES}
 * older dates of the same marks in {@link days} and as many newer ones
 * (a skewed writer's future dates) in {@link future}.
 */
export interface LogCatchupCursor {
  /** ISO date (`YYYY-MM-DD`) the watermark sits on. */
  readonly date: string;
  /** Shard id of the last entry seen; empty string for the legacy pair. */
  readonly shardId: string;
  /** 0-based entry index of the last entry seen within its shard. */
  readonly line: number;
  /** Per-shard last-seen line indexes for {@link date}. */
  readonly shards: Readonly<Record<string, number>>;
  /**
   * Per-shard last-seen line indexes for the window dates strictly
   * older than {@link date}, at most {@link LOG_CATCHUP_WINDOW_DATES}
   * of them (the newest first). A (date, shard) pair covered here is
   * not rescanned whole; anything older than both the window and
   * {@link date} is skipped entirely.
   */
  readonly days: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /**
   * The same marks for the scanned dates strictly NEWER than
   * {@link date} - the dates a clock-skewed writer can stamp. The
   * cursor itself never parks on a future date, so without these a
   * skewed line would read as past the cursor every session until the
   * clock reached its date. At most
   * {@link LOG_CATCHUP_WINDOW_DATES} future dates, the OLDEST kept -
   * the ones the clock reaches soonest. A date here decides per shard
   * exactly like {@link shards}; when the clock reaches the date, the
   * ordinary park-and-window handling takes it over.
   */
  readonly future: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A shard-keyed marks map read out of the file, on a null prototype -
 * shard ids are foreign input and `DEVICE_ID_RE` admits
 * `Object.prototype` member names like `constructor`, which a plain
 * `{}` would inherit as if they were marks.
 */
function parseMarksMap(raw: unknown): Record<string, number> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marks: Record<string, number> = Object.create(null);
  for (const [shard, mark] of Object.entries(raw as Record<string, unknown>)) {
    if (!isNonNegativeInteger(mark)) return null;
    marks[shard] = mark;
  }
  return marks;
}

/**
 * A date-keyed map of shard marks (`days` / `future`) read out of the
 * file, on a null prototype. Every key must be an ISO date and every
 * value a well-shaped marks map; anything else refuses the whole file.
 */
function parseDatedMarks(raw: unknown): Record<string, Record<string, number>> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const dated: Record<string, Record<string, number>> = Object.create(null);
  for (const [date, dayMarks] of Object.entries(raw as Record<string, unknown>)) {
    if (!DATE_SHAPE_RE.test(date)) return null;
    const parsed = parseMarksMap(dayMarks);
    if (parsed === null) return null;
    dated[date] = parsed;
  }
  return dated;
}

/** Absolute path of the cursor file for one identity on one vault. */
export function logCatchupCursorPath(vault: string, identity: string): string {
  return join(vault, DERIVED_STORE_DIR, logCatchupCursorFilename(identity));
}

/**
 * The cursor last recorded for `identity` on the vault, or `null` when
 * nothing usable is recorded: the file is absent, unreadable, not a
 * regular file, or does not carry the watermark shape. Never throws.
 */
export function readLogCatchupCursor(vault: string, identity: string): LogCatchupCursor | null {
  const read = readRegularFileNoFollow(logCatchupCursorPath(vault, identity));
  if (read.status !== "ok") return null;
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    if (typeof raw["date"] !== "string" || !DATE_SHAPE_RE.test(raw["date"])) return null;
    if (typeof raw["shardId"] !== "string") return null;
    if (!isNonNegativeInteger(raw["line"])) return null;
    const marks = parseMarksMap(raw["shards"]);
    if (marks === null) return null;
    // `days` postdates the per-identity file and `future` postdates
    // `days`: a cursor written before either existed simply covered
    // less, so absence reads as an empty window.
    const rawDays = raw["days"];
    let days: Record<string, Record<string, number>>;
    if (rawDays === undefined) days = Object.create(null);
    else {
      const dated = parseDatedMarks(rawDays);
      if (dated === null) return null;
      days = dated;
    }
    const rawFuture = raw["future"];
    let future: Record<string, Record<string, number>>;
    if (rawFuture === undefined) future = Object.create(null);
    else {
      const dated = parseDatedMarks(rawFuture);
      if (dated === null) return null;
      future = dated;
    }
    return {
      date: raw["date"],
      shardId: raw["shardId"],
      line: raw["line"],
      shards: marks,
      days,
      future,
    };
  } catch {
    return null;
  }
}

/**
 * Overwrite the cursor file with `cursor`, in place: an atomic rename
 * over the single file, no siblings left behind, no growth. Refuses
 * (returning `false`) when the cursor shape is wrong or the derived
 * store is itself a symbolic link - a vault received from elsewhere
 * could point it at any directory. Never throws.
 */
export function writeLogCatchupCursor(
  vault: string,
  identity: string,
  cursor: LogCatchupCursor,
): boolean {
  try {
    if (!DATE_SHAPE_RE.test(cursor.date)) return false;
    if (typeof cursor.shardId !== "string") return false;
    if (!isNonNegativeInteger(cursor.line)) return false;
    for (const mark of Object.values(cursor.shards)) {
      if (!isNonNegativeInteger(mark)) return false;
    }
    for (const dated of [cursor.days, cursor.future]) {
      for (const [date, dayMarks] of Object.entries(dated)) {
        if (!DATE_SHAPE_RE.test(date)) return false;
        for (const mark of Object.values(dayMarks)) {
          if (!isNonNegativeInteger(mark)) return false;
        }
      }
    }
    if (derivedDirIsSymlinked(vault, DERIVED_STORE_DIR)) return false;
    const path = logCatchupCursorPath(vault, identity);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteText(path, `${JSON.stringify(cursor)}\n`);
    return true;
  } catch {
    return false;
  }
}
