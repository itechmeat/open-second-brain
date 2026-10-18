/**
 * Cross-agent log catch-up cursor state (t_3b44cd9a).
 *
 * One overwrite-only file per reading identity,
 * `<vault>/.open-second-brain/log-catchup.<identity>.cursor.json`,
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
 * the file name (`[^A-Za-z0-9._-]` -> `_`) because a configured agent
 * name is arbitrary operator input and the file name must stay inside
 * the derived store.
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
 * Import-light on purpose (node:fs, the atomic writer, the no-follow
 * guard, the path constant), so the hook can statically import it and
 * stay cheap when the feature flag is off.
 */

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
 * The single state file name for one identity, directly under
 * {@link DERIVED_STORE_DIR}: `log-catchup.<identity>.cursor.json` with
 * every character outside `[A-Za-z0-9._-]` replaced by `_`, so a hostile
 * or exotic agent name cannot escape the derived store.
 */
export function logCatchupCursorFilename(identity: string): string {
  return `${LOG_CATCHUP_CURSOR_STEM}.${identity.replace(/[^A-Za-z0-9._-]/g, "_")}.cursor.json`;
}

/**
 * How many dates strictly OLDER than {@link LogCatchupCursor.date} keep
 * their per-shard marks in the `days` map. Delayed cross-device sync is
 * the normal case, so yesterday's late-arriving shard must still be
 * readable per (date, shard); the bound keeps the file small no matter
 * how far back the log goes.
 */
export const LOG_CATCHUP_WINDOW_DATES = 3;

/**
 * The watermark: the merge-order position of the last entry seen on
 * {@link date}, plus the per-shard high-water line marks (0-based
 * indexes) for that date, plus {@link LOG_CATCHUP_WINDOW_DATES} older
 * dates of the same marks in {@link days}.
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
    // `days` postdates the per-identity file: a cursor written before it
    // existed simply covered one date, so absence reads as no window.
    const rawDays = raw["days"];
    const days: Record<string, Record<string, number>> = Object.create(null);
    if (rawDays !== undefined) {
      if (rawDays === null || typeof rawDays !== "object" || Array.isArray(rawDays)) return null;
      for (const [date, dayMarks] of Object.entries(rawDays as Record<string, unknown>)) {
        if (!DATE_SHAPE_RE.test(date)) return null;
        const parsed = parseMarksMap(dayMarks);
        if (parsed === null) return null;
        days[date] = parsed;
      }
    }
    return { date: raw["date"], shardId: raw["shardId"], line: raw["line"], shards: marks, days };
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
    for (const [date, dayMarks] of Object.entries(cursor.days)) {
      if (!DATE_SHAPE_RE.test(date)) return false;
      for (const mark of Object.values(dayMarks)) {
        if (!isNonNegativeInteger(mark)) return false;
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
