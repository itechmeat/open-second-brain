/**
 * The rollup-ladder plan of a dream pass (S3): the count-only ladder over
 * the run's facts, and the link-candidate manifest it may ask for, built
 * at most once per run. Split from `dream.ts`, which calls it.
 */

import { buildLinkCandidateManifest, type LinkCandidateManifest } from "./notes/link-candidates.ts";
import { gatedOwnerScopeView } from "./owner-scope-view.ts";
import {
  planRollupLadder,
  readRollupLedger,
  resolveRollupThresholds,
  type RollupLadderPlan,
  type RollupLedger,
} from "./rollup-ladder.ts";
import type { BrainConfig } from "./types.ts";

export function buildRollupPlan(
  vault: string | null,
  cfg: BrainConfig,
  factCount: number,
  runId: string,
  linkCandidates: () => LinkCandidateManifest,
  /** The ledger to plan against; absent, this device's ledger file (a replayed window passes the store's). */
  ledger?: RollupLedger | null,
): RollupLadderPlan {
  return planRollupLadder({
    factCount,
    ledger: ledger === undefined ? readRollupLedger(vault) : ledger,
    thresholds: resolveRollupThresholds(cfg),
    runId,
    linkCandidates,
  });
}

/**
 * The link-candidate manifest for this run, walked at most once and only
 * if something asks for it. Both callers of {@link buildRollupPlan} share
 * one of these, so a runId collision re-plans off the manifest already
 * built rather than walking the vault a second time.
 *
 * No query: the ladder is count-only by design and never learns which
 * items it is folding, so ranking the candidates would be inventing a
 * relevance nothing measured. The manifest says `alphabetical` and names
 * the total, which is the honest form of that.
 */
export function memoizedLinkCandidates(
  vault: string | null,
  agentName: string | undefined,
  readable: ((rel: string) => boolean) | undefined,
): () => LinkCandidateManifest {
  let manifest: LinkCandidateManifest | null = null;
  return () => {
    if (manifest !== null) return manifest;
    // No vault: no user notes for a rollup to link to (design D14).
    if (vault === null) return (manifest = NO_LINK_CANDIDATES);
    const ownerView = gatedOwnerScopeView(vault, agentName);
    manifest = buildLinkCandidateManifest(vault, {
      visible: (rel) => ownerView.visible(rel) && (readable?.(rel) ?? true),
    });
    return manifest;
  };
}

/** The link manifest of a machine with no vault: no notes, so no candidates. */
const NO_LINK_CANDIDATES: LinkCandidateManifest = Object.freeze({
  candidates: Object.freeze([]),
  total: 0,
  truncated: false,
  selection: "alphabetical",
});
