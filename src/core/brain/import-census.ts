/**
 * Post-import read-back census (nothing-writes-silently, Unit F).
 *
 * Every import surface in this build reported what it BELIEVED it had done:
 * `signals_created: 40`, `ingested: [...]`. Nothing ever went back to the
 * vault afterwards and asked whether those forty items are there. When a
 * write is lost - a crash between the write and the fsync, a sync conflict
 * that resolved the other way, a directory an operator cleaned - the counter
 * still says forty, and the loss is invisible until somebody misses the note.
 *
 * This module is that second look. It re-reads the vault through the keys the
 * import ALREADY uses, and reports `attempted / found / missing` in the wave's
 * shared reconciliation vocabulary ({@link ../reconciliation-report.ts}) -
 * which is what makes `missing` a list of NAMED keys rather than a number.
 * A count on its own is the misleading no-op this unit removes: "40 attempted,
 * 38 found" reads as accounted for while nobody can say which two vanished.
 *
 * ## No new index, no new hash
 *
 * Both lanes read back over the key the lane already keys on:
 *
 *   - sessions: the signal dedup hash ({@link ./dedup-hash.ts}), read back
 *     through the same `buildDedupIndex` walk of `Brain/inbox/` and
 *     `Brain/inbox/processed/` that the import consults before every write.
 *     A hash the index cannot find is a signal that is not on disk.
 *   - ingest: the content-hash manifest ({@link ./ingest/content-manifest.ts}),
 *     read back through the same `classifyPaths`. A claimed path counts as
 *     found only when the manifest recorded it AND the bytes on disk still
 *     hash to what was recorded - anything else is a claim nobody can
 *     reproduce.
 *
 * ## What the sessions census does and does not cover
 *
 * It covers the signals the import wrote through its own `writeSignal` call,
 * which always land in `Brain/inbox/`. It does NOT cover extracted facts:
 * those route through `routeExtractedFacts`, whose write target moves to
 * `Brain/pending/` when the write-approval gate is on, and a read-back over
 * the inbox alone would report every staged fact as lost. Naming the scope is
 * the point - a census that quietly covered two thirds of a run would be the
 * same lie in a smaller font.
 *
 * Read-only and idempotent: nothing here writes a byte.
 */

import { canonicalNotePath } from "../path-safety.ts";
import { buildDedupIndex } from "./dedup-hash.ts";
import { classifyPaths, readManifest } from "./ingest/content-manifest.ts";
import {
  buildReconciliationReport,
  deriveReconciliationOutcome,
  type ReconciliationOutcome,
} from "../reconciliation-report.ts";

/**
 * One import's read-back result, flattened for the result payloads it rides
 * on. `missing` names its keys; there is no constructor here that takes a
 * bare count instead.
 */
export interface ImportCensus {
  /** Distinct keys the import claims to have written. */
  readonly attempted: number;
  /** Claimed keys a fresh read of the vault can still find. */
  readonly found: number;
  /** Every claimed key the read-back could NOT find, named and sorted. */
  readonly missing: ReadonlyArray<string>;
  /** `complete` when nothing is missing, `partial` otherwise. */
  readonly outcome: ReconciliationOutcome;
}

/**
 * Build a census from a claim list and a presence test. `claimed` is deduped
 * first: a key claimed twice is one claim, and counting it twice would inflate
 * `attempted` into a number no read-back could ever satisfy.
 */
export function buildReadBackCensus(
  claimed: ReadonlyArray<string>,
  present: (key: string) => boolean,
): ImportCensus {
  const keys = [...new Set(claimed)];
  const missing: string[] = [];
  let found = 0;
  for (const key of keys) {
    if (present(key)) found++;
    else missing.push(key);
  }
  // Sorted so the finding reads the same whatever order the run happened to
  // claim its keys in - a report an operator diffs across runs.
  missing.sort();
  const report = buildReconciliationReport({ attempted: keys.length, found, missing });
  return Object.freeze({
    attempted: report.attempted,
    found: report.found,
    missing: report.missing,
    outcome: deriveReconciliationOutcome(report),
  });
}

/**
 * Sessions lane: read back the dedup hashes of the signals an import claims to
 * have written. The index is built FRESH from disk here - the map the import
 * mutated as it ran is its own belief, and asking a belief to confirm itself
 * measures nothing.
 */
export function censusSessionSignals(
  vault: string,
  claimedHashes: ReadonlyArray<string>,
): ImportCensus {
  if (claimedHashes.length === 0) return buildReadBackCensus([], () => true);
  const index = buildDedupIndex(vault);
  return buildReadBackCensus(claimedHashes, (hash) => index.has(hash));
}

/**
 * Ingest lane: read back the content-manifest entries of the sources an
 * ingest claims to have completed. Found means `unchanged` - recorded, still
 * on disk, and still hashing to the recorded digest. A path that is `new`
 * (never recorded), `modified` (recorded hash no longer matches) or `missing`
 * (gone from disk) is a claim the manifest cannot confirm.
 */
export function censusIngestedPaths(
  vault: string,
  claimedPaths: ReadonlyArray<string>,
): ImportCensus {
  if (claimedPaths.length === 0) return buildReadBackCensus([], () => true);
  // Canonical on both sides: `classifyPaths` reports canonical keys, so a
  // claim spelled any other way would never match its own classification.
  const keys = [...new Set(claimedPaths.map((p) => canonicalNotePath(p)))];
  const confirmed = new Set(classifyPaths(vault, keys, readManifest(vault)).unchanged);
  return buildReadBackCensus(keys, (path) => confirmed.has(path));
}

/**
 * The one wire shape both lanes emit, so a CLI reading and an MCP reading of
 * the same census cannot drift into two spellings of the same finding.
 */
export function serializeImportCensus(census: ImportCensus): Record<string, unknown> {
  return {
    attempted: census.attempted,
    found: census.found,
    missing: [...census.missing],
    outcome: census.outcome,
  };
}
