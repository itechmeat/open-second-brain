/**
 * Retention for the anticipatory context cache
 * (`Brain/.state/anticipatory/`).
 *
 * The cache writes one entry per lineage root and owner scope on every
 * prompt and, before this module, nothing ever deleted one: a live
 * install held 3,647 entries (305 MB). Pruning removes entries whose
 * file is older than {@link ANTICIPATORY_CACHE_RETENTION_MS}, then
 * enforces a hard cap of {@link ANTICIPATORY_CACHE_MAX_ENTRIES} keeping
 * the newest.
 *
 * Cost model: the prune piggybacks on a refresh that already wrote, and
 * at most once per {@link ANTICIPATORY_PRUNE_INTERVAL_MS} (one `stat` of
 * a marker file decides). The read path never prunes, so a warm read
 * pays nothing.
 *
 * Ages come from file mtimes against the wall clock, not from the
 * refresh's injected clock: mtimes are wall-clock facts, and comparing
 * them with a test or replay clock would delete live entries.
 *
 * Fail-soft like the cache itself: any filesystem error ends the prune
 * quietly; a file another process removed first is simply skipped.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { BRAIN_ANTICIPATORY_REL } from "./path-constants.ts";
import { machineStatePath } from "../state/machine-state.ts";

/**
 * How long an entry outlives its last write. Deliberately much longer
 * than the 120 s freshness TTL: a TTL-stale entry still steers the live
 * rebuild with its last signal text (the `stale` read state), so pruning
 * at the TTL would turn every idle session's `stale` read into a bare
 * `miss`. A day keeps that behaviour and bounds the directory.
 */
export const ANTICIPATORY_CACHE_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** Hard cap on cache entries kept after the age pass (newest win). */
export const ANTICIPATORY_CACHE_MAX_ENTRIES = 256;
/** Minimum spacing between two opportunistic prunes. */
export const ANTICIPATORY_PRUNE_INTERVAL_MS = 10 * 60 * 1_000;

/** Marker whose mtime records the last prune; never pruned itself. */
const PRUNE_MARKER = ".last-prune";
const ENTRY_SUFFIX = ".json";

export interface PruneAnticipatoryCacheOptions {
  /** Absolute path that must survive (the entry the caller just wrote). */
  readonly keep?: string;
}

export interface PruneAnticipatoryCacheResult {
  readonly ran: boolean;
  readonly removed: number;
}

interface Candidate {
  readonly path: string;
  readonly mtimeMs: number;
  readonly entry: boolean;
}

function removeQuietly(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function dueForPrune(markerPath: string, nowMs: number): boolean {
  try {
    return nowMs - statSync(markerPath).mtimeMs >= ANTICIPATORY_PRUNE_INTERVAL_MS;
  } catch {
    return true; // no marker yet
  }
}

function listCandidates(dir: string): Candidate[] {
  const out: Candidate[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isFile() || dirent.name === PRUNE_MARKER) continue;
    const path = join(dir, dirent.name);
    try {
      out.push({
        path,
        mtimeMs: statSync(path).mtimeMs,
        entry: dirent.name.endsWith(ENTRY_SUFFIX),
      });
    } catch {
      // Removed by a concurrent prune between readdir and stat.
    }
  }
  return out;
}

/**
 * Prune the anticipatory cache: drop files older than the retention
 * window (entries and stray atomic-write temp files alike), then cap the
 * remaining entries at the newest {@link ANTICIPATORY_CACHE_MAX_ENTRIES}.
 * Rate-limited; never throws.
 */
export function pruneAnticipatoryCache(
  vault: string,
  options: PruneAnticipatoryCacheOptions = {},
): PruneAnticipatoryCacheResult {
  try {
    const dir = machineStatePath(vault, BRAIN_ANTICIPATORY_REL);
    const markerPath = join(dir, PRUNE_MARKER);
    const nowMs = Date.now();
    if (!dueForPrune(markerPath, nowMs)) {
      return { ran: false, removed: 0 };
    }
    let candidates: Candidate[];
    try {
      candidates = listCandidates(dir);
    } catch {
      return { ran: false, removed: 0 }; // no cache directory yet
    }
    // Stamp first: a concurrent writer that stats the marker now skips
    // its own scan instead of racing this one over the same files.
    atomicWriteFileSync(markerPath, `${new Date(nowMs).toISOString()}\n`);

    let removed = 0;
    const kept: Candidate[] = [];
    for (const candidate of candidates) {
      if (candidate.path === options.keep) {
        kept.push(candidate);
        continue;
      }
      if (nowMs - candidate.mtimeMs > ANTICIPATORY_CACHE_RETENTION_MS) {
        if (removeQuietly(candidate.path)) removed++;
      } else if (candidate.entry) {
        kept.push(candidate);
      }
    }

    if (kept.length > ANTICIPATORY_CACHE_MAX_ENTRIES) {
      // Newest first; the kept path sorts to the front so it always survives.
      const ordered = kept.toSorted((a, b) => {
        if (a.path === options.keep) return -1;
        if (b.path === options.keep) return 1;
        return b.mtimeMs - a.mtimeMs;
      });
      for (const candidate of ordered.slice(ANTICIPATORY_CACHE_MAX_ENTRIES)) {
        if (removeQuietly(candidate.path)) removed++;
      }
    }
    return { ran: true, removed };
  } catch {
    return { ran: false, removed: 0 };
  }
}
