/**
 * Rank and assemble: rank the fused candidate pool, then run the phases
 * that can still drop or re-order a ranked row - traversal expansion, the
 * relevance floor, diversity/relevance rerank, and the frontmatter-backed
 * filters (status, property, degree, visibility, agent, scope).
 *
 * Owns the pool width, because every one of those phases is a reason to
 * rank more rows than the caller asked for.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { rerankByRelevance } from "../enrich.ts";
import { applyTraversal } from "../graph-phases.ts";
import { mmrRerank } from "../mmr.ts";
import { rankResults } from "../ranker.ts";
import { applyExactStateBarrier, type FrontmatterCache } from "../result-filters.ts";
import { semanticPoolSize } from "../semantic-phase.ts";
import { applyTemporalBridge } from "../temporal-bridge.ts";
import { applyPoolFilters, resolvePoolFilters, type FilterContext } from "./pool-filters.ts";
import type { CandidateSignals } from "./candidate-signals.ts";
import type { HydratedChunk, KeywordHit, SemanticHit, Store } from "../store.ts";
import type { ResolvedTimeRange } from "../time-range.ts";
import type { TemporalIntent } from "../temporal-intent.ts";
import type {
  BrainSearchResult,
  ResolvedSearchConfig,
  SearchOptions,
  SearchSessionFocus,
  StructuredRecallQueryDocument,
  WeightProfile,
} from "../types.ts";

/** Widening factors for the phases that need a pool wider than `limit`. */
const POOL_LIMIT_MULTIPLIER = 3;
const POOL_MIN_WIDTH = 30;

/** Traversal is off at zero hops; MMR is off at a lambda of 1. */
const NO_TRAVERSAL_HOPS = 0;
const MMR_OFF_LAMBDA = 1;

export interface AssemblyInput {
  readonly store: Store;
  readonly config: ResolvedSearchConfig;
  readonly opts: SearchOptions;
  readonly keywordHits: ReadonlyArray<KeywordHit>;
  readonly semanticHits: ReadonlyArray<SemanticHit>;
  readonly hydrated: ReadonlyMap<number, HydratedChunk>;
  readonly signals: CandidateSignals;
  readonly relationalRankedChunkIds: ReadonlyArray<number>;
  readonly weightProfile: WeightProfile | undefined;
  readonly sessionFocus: SearchSessionFocus | null;
  readonly semanticEnabled: boolean;
  readonly structured: StructuredRecallQueryDocument | undefined;
  readonly frontmatterCache: FrontmatterCache;
  readonly timeRange: ResolvedTimeRange | null;
  readonly temporalIntent: TemporalIntent | null;
  readonly declaredEventTimeMs: (path: string) => number | null;
  readonly limit: number;
}

interface Assembly {
  readonly preVisibility: number;
  readonly visible: ReadonlyArray<BrainSearchResult>;
  /** Whether the cap truncated the pool, as opposed to the pool running out. */
  readonly capHit: boolean;
}

export function assembleRankedResults(input: AssemblyInput): ReadonlyArray<BrainSearchResult> {
  const { config, opts, limit } = input;

  const filters = resolvePoolFilters(opts);
  const filterContext: FilterContext = {
    vault: config.vault,
    store: input.store,
    frontmatterCache: input.frontmatterCache,
  };

  // MMR and traversal both need a candidate pool wider than `limit`:
  // MMR diversifies from it, and traversal seeds expansion from it (a
  // narrow pool lets a high-parent expansion crowd a genuine but
  // lower-ranked hit out of the final window). When both are disabled
  // the pool collapses back to the historical rankLimit.
  // The structured exclusion lane drops rows after this stage, so it
  // widens the pool for the same reason a frontmatter filter does.
  const hasStructuredExclusions = (input.structured?.lex.exclude.length ?? 0) > 0;
  const mmrLambda = opts.mmrLambda ?? config.recall.mmrLambda;
  const mmrActive = mmrLambda < MMR_OFF_LAMBDA;
  // Relevance floor + rerank (Search & Recall Quality Suite). The floor
  // drops sub-threshold candidates before the diversity rerank so a
  // query with no sufficiently relevant memory returns no match; the
  // rerank re-orders the qualified set by core textual relevance. Both
  // off by default keep results byte-identical.
  const scoreFloor = opts.threshold ?? 0;
  const rerankActive = opts.rerank === true;
  // Cross-encoder rerank (retrieval-precision-quality-loop, card A): the
  // learned final reader step re-scores the top-K fused candidates. When
  // it is on, the candidate pool must be at least `top_k` wide so a
  // genuinely-relevant hit the heuristic ranker placed deep can be pulled
  // into the final window. Off by default keeps the pool byte-identical.
  const crossEncoderActive = config.rerank.enabled;
  const maxHops = opts.maxHops ?? config.recall.maxHops;
  const traversalActive = maxHops > NO_TRAVERSAL_HOPS;
  const baseRankLimit =
    filters.canDropRows || hasStructuredExclusions ? semanticPoolSize(limit) : limit;
  const rankLimit =
    mmrActive || traversalActive || crossEncoderActive
      ? Math.max(
          baseRankLimit,
          limit * POOL_LIMIT_MULTIPLIER,
          POOL_MIN_WIDTH,
          crossEncoderActive ? config.rerank.topK : 0,
        )
      : baseRankLimit;

  // Rank → traverse → diversify → property filter → visibility scope,
  // for a given candidate cap. Returns the pre-visibility count, the
  // post-visibility list, and whether the cap was actually hit (so the
  // caller can tell "the pool ran out" from "the cap truncated more").
  const assemble = (rankCap: number): Assembly => {
    let ranked = rankCandidates(input, rankCap);
    const capHit = ranked.length >= rankCap;
    // Retrieval-time staleness barrier (t_b0c9d0a3): drop any exact-state
    // lane artifact a stale/older index may still hold, before any later
    // phase can surface it. No-op (same reference) when the pool has none,
    // so a vault that never used the lane is byte-identical.
    ranked = applyExactStateBarrier(ranked).slice();
    // Link-graph traversal (v0.13.0): walk outbound links from the top
    // hits and surface related documents not already matched, scored by
    // decay. No-op when maxHops == 0. Runs before MMR so expansions are
    // subject to the same diversity pass.
    if (traversalActive && ranked.length > 0) {
      ranked = applyTraversal(input.store, ranked, {
        maxHops,
        hopDecay: config.recall.hopDecay,
        maxExpansionPerHit: config.recall.maxExpansionPerHit,
      });
      // Temporal bridge (t_c3871f0c): with an active time range,
      // traversal expansions must stay within a padded event-time
      // neighbourhood of the window - linked causes/consequences
      // bridge in with proximity-decayed scores, arbitrary old
      // neighbours do not. Event time = validity start, else mtime.
      if (input.timeRange !== null) {
        ranked = applyTemporalBridge(ranked, {
          range: input.timeRange,
          eventTimeMs: (path) => eventTimeOrMtimeMs(config.vault, path, input.declaredEventTimeMs),
        });
      }
    }
    // Relevance floor (Search & Recall Quality Suite): drop
    // sub-threshold candidates BEFORE diversity so the rerank works over
    // the qualified set only. No-op when the floor is 0.
    if (scoreFloor > 0) {
      ranked = ranked.filter((r) => r.score >= scoreFloor);
    }
    // Diversity rerank (v0.13.0). No-op when lambda >= 1 or < 2 results.
    if (mmrActive) {
      ranked = mmrRerank(ranked, { lambda: mmrLambda });
    }
    // Relevance rerank (Search & Recall Quality Suite): re-order the
    // qualified set by core textual relevance, a deeper-relevance second
    // pass. Opt-in; replaces the diversity ordering when requested.
    if (rerankActive) {
      ranked = rerankByRelevance(ranked).slice();
    }
    return { ...applyPoolFilters(ranked, filters, filterContext), capHit };
  };

  let assembled = assemble(rankLimit);
  // Default-scope visibility (no explicit filter, so no overfetch above)
  // can drop tagged pages and leave fewer than `limit` rows while more
  // untagged matches sit deeper in the candidate pool. When that happens
  // and the narrow cap was actually hit, re-assemble once at the wider
  // cap from the same in-memory candidates - no extra DB fetch. Untagged
  // vaults never drop rows, so this never fires and their results stay
  // byte-identical.
  if (
    !filters.canDropRows &&
    assembled.visible.length < limit &&
    assembled.visible.length < assembled.preVisibility &&
    assembled.capHit
  ) {
    const wideCap = Math.max(
      semanticPoolSize(limit),
      limit * POOL_LIMIT_MULTIPLIER,
      POOL_MIN_WIDTH,
    );
    if (wideCap > rankLimit) assembled = assemble(wideCap);
  }
  return assembled.visible;
}

function rankCandidates(input: AssemblyInput, rankCap: number): BrainSearchResult[] {
  const { config, opts, signals } = input;
  return rankResults(
    {
      keyword: input.keywordHits,
      semantic: input.semanticHits,
      hydrated: input.hydrated,
      inboundLinkSources: signals.inboundLinkSources,
      tagsByDoc: signals.tagsByDoc,
      ...(signals.entityMatchByChunk !== undefined
        ? { entityMatchByChunk: signals.entityMatchByChunk }
        : {}),
      ...(signals.activationByChunk !== undefined
        ? { activationByChunk: signals.activationByChunk }
        : {}),
      ...(signals.coAccessByChunk !== undefined
        ? { coAccessByChunk: signals.coAccessByChunk }
        : {}),
      ...(signals.trendByDoc !== undefined ? { trendByDoc: signals.trendByDoc } : {}),
      ...(signals.reuseRateByChunk !== undefined
        ? { reuseRateByChunk: signals.reuseRateByChunk }
        : {}),
      ...(input.relationalRankedChunkIds.length > 0
        ? { relationalRankedChunkIds: input.relationalRankedChunkIds }
        : {}),
      ...(signals.eventTimeMsByChunk !== undefined
        ? { eventTimeMsByChunk: signals.eventTimeMsByChunk }
        : {}),
    },
    {
      keywordWeight: opts.keywordWeight ?? config.keywordWeight,
      semanticWeight: opts.semanticWeight ?? config.semanticWeight,
      limit: rankCap,
      semanticEnabled: input.semanticEnabled,
      recency: {
        shape: config.recall.recencyShape,
        scale: config.recall.recencyScale,
        amplitude: config.recall.recencyAmplitude,
      },
      ...(input.weightProfile !== undefined ? { weightProfile: input.weightProfile } : {}),
      ...(input.sessionFocus !== undefined ? { sessionFocus: input.sessionFocus } : {}),
      fusionMode: config.fusionMode,
      rrfK: config.rrfK,
      temporalIntent: input.temporalIntent,
    },
  );
}

/** Declared event time, falling back to storage mtime. */
function eventTimeOrMtimeMs(
  vault: string,
  path: string,
  declaredEventTimeMs: (path: string) => number | null,
): number {
  const declared = declaredEventTimeMs(path);
  if (declared !== null) return declared;
  try {
    return statSync(join(vault, path)).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}
