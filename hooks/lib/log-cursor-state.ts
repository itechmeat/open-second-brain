/**
 * Cross-agent log catch-up cursor state (t_3b44cd9a).
 *
 * One overwrite-only file, `<vault>/.open-second-brain/log-catchup.cursor.json`,
 * holding the watermark of what the catch-up lane last showed the agent
 * on this device: the `(date, shardId, line)` merge-order position of the
 * last entry seen, plus the per-shard high-water line marks for that
 * date. Vault-global and un-synced derived state, beside
 * `backlog-nudge.count` and for the same reasons: the watermark belongs
 * to this device's reading progress, so syncing it would make devices
 * fight over each other's cursors, and per-session hook-state is the
 * wrong lifetime for "since my last look".
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

/** The single state file name, directly under {@link DERIVED_STORE_DIR}. */
export const LOG_CATCHUP_CURSOR_FILENAME = "log-catchup.cursor.json";

/**
 * The watermark: the merge-order position of the last entry seen on
 * {@link date}, plus the per-shard high-water line marks (0-based entry
 * indexes) for that date.
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
}

const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Absolute path of the cursor file for one vault. */
export function logCatchupCursorPath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, LOG_CATCHUP_CURSOR_FILENAME);
}

/**
 * The cursor last recorded for the vault, or `null` when nothing usable
 * is recorded: the file is absent, unreadable, not a regular file, or
 * does not carry the watermark shape. Never throws.
 */
export function readLogCatchupCursor(vault: string): LogCatchupCursor | null {
  const read = readRegularFileNoFollow(logCatchupCursorPath(vault));
  if (read.status !== "ok") return null;
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    if (typeof raw["date"] !== "string" || !DATE_SHAPE_RE.test(raw["date"])) return null;
    if (typeof raw["shardId"] !== "string") return null;
    if (!isNonNegativeInteger(raw["line"])) return null;
    const shards = raw["shards"];
    if (shards === null || typeof shards !== "object" || Array.isArray(shards)) return null;
    const marks: Record<string, number> = {};
    for (const [shard, mark] of Object.entries(shards as Record<string, unknown>)) {
      if (!isNonNegativeInteger(mark)) return null;
      marks[shard] = mark;
    }
    return { date: raw["date"], shardId: raw["shardId"], line: raw["line"], shards: marks };
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
export function writeLogCatchupCursor(vault: string, cursor: LogCatchupCursor): boolean {
  try {
    if (!DATE_SHAPE_RE.test(cursor.date)) return false;
    if (typeof cursor.shardId !== "string") return false;
    if (!isNonNegativeInteger(cursor.line)) return false;
    for (const mark of Object.values(cursor.shards)) {
      if (!isNonNegativeInteger(mark)) return false;
    }
    if (derivedDirIsSymlinked(vault, DERIVED_STORE_DIR)) return false;
    const path = logCatchupCursorPath(vault);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteText(path, `${JSON.stringify(cursor)}\n`);
    return true;
  } catch {
    return false;
  }
}
