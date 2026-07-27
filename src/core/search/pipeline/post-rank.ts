/**
 * Post-rank pool phases: everything that still adds, removes or re-orders
 * a candidate AFTER ranking and BEFORE the final `limit` slice - so a
 * demoted row can fall out of the window and a promoted one can enter it.
 *
 * Order is the contract here: structured exclusions, relation polarity,
 * reinforce, the cross-encoder reader, then the deterministic
 * rank-adjustment sink that emits the trust receipts.
 */

import { emitGatedTelemetry } from "../../brain/continuity/emit.ts";
import {
  buildMemoryTrustAssessment,
  buildRetrievalDecisionTrace,
} from "../../brain/trust/retrieval-receipts.ts";
import { trustGateAdjuster } from "../../brain/trust/retrieval-gate.ts";
import { applyRelationPolarityPhase } from "../graph-phases.ts";
import { applyRankAdjusters, type RankAdjuster } from "../rank-adjust.ts";
import { applyReinforceBoost, loadReinforceStrengths } from "../reinforce.ts";
import { applyCrossEncoderRerank } from "../rerank/index.ts";
import {
  readCachedFrontmatter,
  supersedeFadeAdjuster,
  type FrontmatterCache,
} from "../result-filters.ts";
import { applyStructuredExclusions } from "../structured-lanes.ts";
import type { Store } from "../store.ts";
import type {
  BrainSearchResult,
  ResolvedSearchConfig,
  SearchOptions,
  StructuredRecallQueryDocument,
} from "../types.ts";

export interface PostRankInput {
  readonly store: Store;
  readonly config: ResolvedSearchConfig;
  readonly opts: SearchOptions;
  /** Residual query text, the cross-encoder's reader input. */
  readonly query: string;
  readonly pool: ReadonlyArray<BrainSearchResult>;
  readonly structured: StructuredRecallQueryDocument | undefined;
  readonly frontmatterCache: FrontmatterCache;
}

export interface TrustReceipts {
  readonly retrievalDecisionTrace: ReturnType<typeof buildRetrievalDecisionTrace>;
  readonly memoryTrustAssessment: ReturnType<typeof buildMemoryTrustAssessment>;
}

export interface PostRankOutcome {
  readonly results: ReadonlyArray<BrainSearchResult>;
  /** Null on the default path, where the outcome shape stays unchanged. */
  readonly trustReceipts: TrustReceipts | null;
  readonly warnings: string[];
}

export async function applyPostRankPhases(input: PostRankInput): Promise<PostRankOutcome> {
  const { store, config, opts, frontmatterCache } = input;
  const warnings: string[] = [];

  const excluded = applyStructuredExclusions(input.pool, input.structured);
  // Relation polarity (recall-trust-suite): typed relation edges adjust
  // the pool BEFORE the final slice so a demoted predecessor can fall
  // out of the window and a pulled-in successor can enter it. A pool
  // whose documents declare no typed edges passes through untouched.
  const polarized = config.recall.relationPolarityEnabled
    ? applyRelationPolarityPhase(store, excluded, opts.includeSuperseded === true)
    : excluded;
  // Self-tuning reinforce (Search & Recall Quality Suite): opt-in. When
  // the caller passes a reinforce set, the persisted ledger lifts
  // proven-useful memories by a bounded boost BEFORE the top_k cut, so
  // a reinforced hit can enter the window. Absent leaves the pool
  // untouched; an empty ledger is a no-op either way.
  const reinforced =
    opts.reinforce !== undefined
      ? applyReinforceBoost(polarized, loadReinforceStrengths(config.vault))
      : polarized;
  // Cross-encoder rerank (retrieval-precision-quality-loop, card A): the
  // final reader step, appended AFTER every heuristic rerank. Disabled
  // (default) returns the pool unchanged (byte-identical); enabled but
  // unconfigured throws a typed config error; enabled + a request-time
  // endpoint error degrades to the heuristic ordering and records one
  // fail-open telemetry warning. Runs over the widened pool so a deep
  // candidate can be promoted into the final `limit` window below.
  const reranked = await applyCrossEncoderRerank(reinforced, input.query, config.rerank, {
    onTelemetry: (event) =>
      emitGatedTelemetry(event.status === "error", () => {
        warnings.push(`rerank_degraded: ${event.reason ?? "endpoint error"}`);
      }),
  });
  // Kernel 1 (t_5f61130a): the deterministic rank-adjustment sink between
  // ranking and result emission, mounted on BOTH the semantic and the
  // pure-lexical paths (both flow through this single pre-slice pool).
  // Registered adjusters return a per-candidate verdict; with none
  // registered the pool is returned unchanged, so the default path is
  // byte-identical. Runs BEFORE the slice so a gate exclusion lets a
  // deeper survivor backfill the window rather than shrinking it.
  const rankAdjusters: RankAdjuster[] = [];
  if (config.recall.retrievalTrustGateEnabled) {
    rankAdjusters.push(
      trustGateAdjuster((path) => readCachedFrontmatter(frontmatterCache, config.vault, path)),
    );
  }
  if (config.recall.supersedeFadeEnabled) {
    // Relation-only supersede fade (t_c4a9cef8): fetch the pool's typed
    // relations once and fade any candidate a `superseded_by` edge marks
    // superseded, the same source of truth `attachTrustMetadata` uses.
    const poolDocIds = Array.from(new Set(reranked.map((r) => r.documentId)));
    const relByPoolDoc = store.typedRelationsForDocuments(poolDocIds);
    rankAdjusters.push(supersedeFadeAdjuster((documentId) => relByPoolDoc.get(documentId) ?? []));
  }
  const adjusted = applyRankAdjusters(reranked, rankAdjusters);
  // Per-pack retrieval trust receipts (t_5f61130a): compact references
  // consistent with the context-receipt model. Built only when the gate
  // ran, so the outcome shape stays byte-identical on the default path.
  const trustReceipts = config.recall.retrievalTrustGateEnabled
    ? {
        retrievalDecisionTrace: buildRetrievalDecisionTrace({
          surfaced: adjusted.results.length,
          excluded: adjusted.excluded,
        }),
        memoryTrustAssessment: buildMemoryTrustAssessment({
          surfaced: adjusted.results.length,
          excluded: adjusted.excluded,
        }),
      }
    : null;

  return { results: adjusted.results, trustReceipts, warnings };
}
