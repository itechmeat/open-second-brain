/**
 * Backlog nudge state (session-mining-economy, t_0358af42).
 *
 * Once-per-change state for the SessionStart backlog nudge: one
 * overwrite-only file, `<vault>/.open-second-brain/backlog-nudge.count`,
 * holding the undistilled count the hook last injected. Vault-global and
 * un-synced derived state - beside `hygiene-digest.hash`, and for the same
 * reason: per-session scope is the wrong lifetime for "once per change",
 * because the backlog belongs to the vault and must re-arm in a new
 * session. Size one, self-overwriting, no cleanup path, so the file cannot
 * grow.
 *
 * Fail-soft on both sides, mirroring the hygiene-digest convention: a
 * missing, unreadable, non-regular or corrupt file reads as `null`, which
 * compares as "changed" so the next eligible session emits again rather
 * than staying silent forever, and a write reports `false` instead of
 * throwing so the hook's silent-exit-0 contract holds.
 *
 * The module is deliberately import-light (node:fs, the atomic writer, the
 * no-follow guard, the path constant), so the hook can statically import
 * it and still stay cheap when the feature flag is off. The heavy census
 * is the hook's own dynamic import, loaded after every gate.
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
export const BACKLOG_NUDGE_COUNT_FILENAME = "backlog-nudge.count";

/** A state file holds exactly one non-negative integer and nothing else. */
const COUNT_LINE_RE = /^\d+$/;

/** Absolute path of the state file for one vault. */
export function backlogNudgeStatePath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, BACKLOG_NUDGE_COUNT_FILENAME);
}

/**
 * The count last recorded for the vault, or `null` when nothing usable is
 * recorded: the file is absent, unreadable, not a regular file, or does
 * not hold a single non-negative integer. Never throws.
 */
export function readBacklogNudgeCount(vault: string): number | null {
  const read = readRegularFileNoFollow(backlogNudgeStatePath(vault));
  if (read.status !== "ok") return null;
  const line = read.text.trim();
  if (!COUNT_LINE_RE.test(line)) return null;
  const value = Number(line);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * True when `count` is exactly what the state file holds. A missing or
 * corrupt record compares unequal: the caller emits and rewrites, which is
 * the lose-not-duplicate direction.
 */
export function backlogNudgeCountMatches(vault: string, count: number): boolean {
  return readBacklogNudgeCount(vault) === count;
}

/**
 * Overwrite the state file with `count`, in place: an atomic rename over
 * the single file, no siblings left behind, no growth. Refuses (returning
 * `false`) when the derived store is itself a symbolic link - a vault
 * received from elsewhere could point it at any directory. Never throws.
 */
export function writeBacklogNudgeCount(vault: string, count: number): boolean {
  try {
    if (!Number.isSafeInteger(count) || count < 0) return false;
    if (derivedDirIsSymlinked(vault, DERIVED_STORE_DIR)) return false;
    const path = backlogNudgeStatePath(vault);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteText(path, `${count}\n`);
    return true;
  } catch {
    return false;
  }
}
