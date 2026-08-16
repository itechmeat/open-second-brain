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
import { RETRIEVAL_DEGRADATION, noteDegradation } from "../retrieval-trail.ts";
import type { RetrievalDegradationSink } from "../retrieval-trail.ts";
import type { CandidateSignals } from "./candidate-signals.ts";
import type { DuplicatePassageLocation } from "../search-result.ts";
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

/**
 * Joins the two halves of a duplicate-identity key. Never occurs in a
 * sha256 hex digest, so the concatenation cannot be ambiguous.
 */
const DUPLICATE_KEY_SEPARATOR = ":";

/** Traversal is off at zero hops; MMR is off at a lambda of 1. */
const NO_TRAVERSAL_HOPS = 0;
const MMR_OFF_LAMBDA = 1;

/**
 * One row past the cap: enough to SEE truncation, never enough to change
 * the answer. See {@link assembleRankedResults} for why the cap is
 * measured rather than inferred.
 */
const CAP_PROBE_ROW = 1;

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
  /**
   * The single instant the request resolved, forwarded to the ranker so
   * the freshness layer scores against the same clock every other
   * time-resolving decision in this call used. Without it the ranker
   * falls back to its own `Date.now()` and a score - and therefore the
   * exact-float first rung of the tie-break ladder - carries a clock
   * reading taken at an arbitrary later point in the pipeline.
   */
  readonly nowMs: number;
  /**
   * Typed degradation sink (evidence-at-the-boundary, C2), threaded like
   * the pipeline's `warnings` array. This stage computed three recall
   * narrowings and reported none of them: the cap that truncated the
   * pool, the relevance floor that dropped ranked rows, and the scope
   * filters that removed them - the last being why a query answered under
   * an owner or session scope used to look exactly like an empty vault.
   */
  readonly degraded: RetrievalDegradationSink;
}

interface Assembly {
  readonly preVisibility: number;
  readonly visible: ReadonlyArray<BrainSearchResult>;
  /** Whether the cap truncated the pool, as opposed to the pool running out. */
  readonly capHit: boolean;
  /** Rows the exact-duplicate merge folded into a higher-ranked row. */
  readonly mergedAway: number;
  /** Ranked rows the caller's relevance floor removed. */
  readonly floorDropped: number;
}

/** The location record a merged-away duplicate leaves on its survivor. */
function duplicateLocation(r: BrainSearchResult): DuplicatePassageLocation {
  return Object.freeze({
    documentId: r.documentId,
    chunkId: r.chunkId,
    path: r.path,
    title: r.title,
    startLine: r.startLine,
    endLine: r.endLine,
  });
}

/**
 * The duplicate-identity key of a hydrated candidate, or `null` when the
 * row cannot state one.
 *
 * Both halves are sha256 hex written on every index run since schema v1:
 * `chunks.content_hash` over the passage, `documents.content_hash` over
 * the whole source file. The document half is load-bearing, not belt and
 * braces - frontmatter is stripped before chunking, so two genuinely
 * distinct records that share a body (the same rule with a different
 * `freshness_trend`, the same prose with a different `authored_at`) hash
 * their chunks identically while the ranker scores them differently on
 * purpose. Requiring both means the merge fires only on a real copy of a
 * file, where the merged-away row provably carries nothing but its path.
 */
function duplicateKey(hydrated: HydratedChunk | undefined): string | null {
  if (hydrated?.contentHash === undefined || hydrated.documentHash === undefined) return null;
  return `${hydrated.documentHash}${DUPLICATE_KEY_SEPARATOR}${hydrated.contentHash}`;
}

/**
 * Fold byte-identical passages into their highest-ranked occurrence.
 *
 * Equal key means equal bytes at both the passage and the file level, so
 * the second occurrence adds no information to the answer while consuming
 * a slot in the caller's window; MMR only demoted it, and a demoted row is
 * still a returned row. Every folded location is recorded on the survivor,
 * so nothing is silently dropped.
 *
 * A near-duplicate hashes differently and is left entirely alone - the
 * diversity rerank remains the only thing that judges similarity.
 * A candidate whose hydrated row states no key (traversal expansions,
 * hydrated through the representative-chunk read) is passed through
 * untouched rather than treated as equal to its peers.
 *
 * `ranked` is score-sorted, so the survivor is always the best-ranked
 * occurrence and the relative order of the surviving rows is preserved.
 */
function mergeExactDuplicates(
  ranked: ReadonlyArray<BrainSearchResult>,
  hydrated: ReadonlyMap<number, HydratedChunk>,
): { readonly results: BrainSearchResult[]; readonly mergedAway: number } {
  const survivorAt = new Map<string, number>();
  const foldedInto = new Map<number, DuplicatePassageLocation[]>();
  const results: BrainSearchResult[] = [];
  for (const r of ranked) {
    const hash = duplicateKey(hydrated.get(r.chunkId));
    if (hash === null) {
      results.push(r);
      continue;
    }
    const at = survivorAt.get(hash);
    if (at === undefined) {
      survivorAt.set(hash, results.length);
      results.push(r);
      continue;
    }
    const folded = foldedInto.get(at);
    if (folded === undefined) foldedInto.set(at, [duplicateLocation(r)]);
    else folded.push(duplicateLocation(r));
  }
  let mergedAway = 0;
  for (const [at, locations] of foldedInto) {
    mergedAway += locations.length;
    results[at] = Object.freeze({
      ...results[at]!,
      duplicates: Object.freeze(locations),
    });
  }
  return { results, mergedAway };
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
    // Rank ONE row past the cap, so "the cap bit" is measured rather than
    // inferred. A pool whose length merely EQUALS the cap is the exhausted
    // corpus and the truncated one at once, and reporting the first as
    // `rank-cap-truncated-pool` told the caller matches existed below a cut
    // that never happened - the pool ended there. `rankResults` sorts the
    // whole fused candidate set and slices last, so the retained prefix is
    // byte-identical to ranking at `rankCap` and the probe costs one result
    // object. The rejected alternative was counting the fused candidates
    // here from the lane hits: that is a second copy of the ranker's own
    // admission rules (a hit whose chunk failed to hydrate is dropped, the
    // relational arm adds candidates no lane matched), and two copies of
    // one rule are what drift.
    const probed = rankCandidates(input, rankCap + CAP_PROBE_ROW);
    const capHit = probed.length > rankCap;
    let ranked = capHit ? probed.slice(0, rankCap) : probed;
    // Retrieval-time staleness barrier (t_b0c9d0a3): drop any exact-state
    // lane artifact a stale/older index may still hold, before any later
    // phase can surface it. No-op (same reference) when the pool has none,
    // so a vault that never used the lane is byte-identical.
    ranked = applyExactStateBarrier(ranked).slice();
    // Exact-duplicate merge (what-the-index-already-knew, task D): fold
    // byte-identical passages into their best-ranked occurrence BEFORE
    // traversal and the diversity rerank, so a duplicate neither seeds
    // expansion twice nor pays for a quadratic Jaccard comparison that
    // the hash already settled. No-op when the pool holds no duplicates.
    const merge = mergeExactDuplicates(ranked, input.hydrated);
    ranked = merge.results;
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
    let floorDropped = 0;
    if (scoreFloor > 0) {
      const qualified = ranked.filter((r) => r.score >= scoreFloor);
      floorDropped = ranked.length - qualified.length;
      ranked = qualified;
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
    return {
      ...applyPoolFilters(ranked, filters, filterContext),
      capHit,
      mergedAway: merge.mergedAway,
      floorDropped,
    };
  };

  // The cap the FINAL assembly ran under: the backfill below may widen it,
  // and reporting the first cap would name a number that no longer bound
  // the answer.
  let effectiveCap = rankLimit;
  let assembled = assemble(rankLimit);
  // Two phases can leave fewer than `limit` rows out of a pool that was
  // capped at `limit`, while more qualifying matches sit deeper in the
  // candidate list:
  //
  //  - default-scope visibility (no explicit filter, so no overfetch
  //    above) drops tagged pages; untagged vaults never drop a row, so
  //    this never fires for them,
  //  - the exact-duplicate merge folds byte-identical passages away.
  //
  // In either case, and only when the narrow cap was actually hit (as
  // opposed to the candidate list simply running out), re-assemble once
  // at the wider cap from the same in-memory candidates - no extra DB
  // fetch. A pool with no dropped and no merged rows never re-assembles,
  // so its results stay byte-identical.
  const visibilityDropped =
    !filters.canDropRows && assembled.visible.length < assembled.preVisibility;
  if (
    assembled.visible.length < limit &&
    assembled.capHit &&
    (visibilityDropped || assembled.mergedAway > 0)
  ) {
    const wideCap = Math.max(
      semanticPoolSize(limit),
      limit * POOL_LIMIT_MULTIPLIER,
      POOL_MIN_WIDTH,
    );
    if (wideCap > rankLimit) {
      assembled = assemble(wideCap);
      effectiveCap = wideCap;
    }
  }
  noteAssemblyNarrowings(input.degraded, assembled, effectiveCap);
  return assembled.visible;
}

/**
 * Name what this stage removed, once, against the assembly that actually
 * produced the answer. Recorded here rather than inside `assemble` because
 * that closure can run twice for one query, and a caller reading two
 * identical codes would think two separate things narrowed the pool.
 */
function noteAssemblyNarrowings(
  sink: RetrievalDegradationSink,
  assembled: Assembly,
  cap: number,
): void {
  if (assembled.capHit) {
    noteDegradation(sink, RETRIEVAL_DEGRADATION.rankCapTruncatedPool, { cap });
  }
  if (assembled.floorDropped > 0) {
    noteDegradation(sink, RETRIEVAL_DEGRADATION.relevanceFloorDroppedRows, {
      dropped: assembled.floorDropped,
    });
  }
  // `preVisibility` is the row count before visibility, ownership and the
  // composite session/project scope ran. The difference is the answer to
  // "did a scope remove my results", which nothing could ask before.
  const scoped = assembled.preVisibility - assembled.visible.length;
  if (scoped > 0) {
    noteDegradation(sink, RETRIEVAL_DEGRADATION.scopeFiltersDroppedRows, {
      dropped: scoped,
      before: assembled.preVisibility,
    });
  }
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
      ...(signals.tierByDoc !== undefined ? { tierByDoc: signals.tierByDoc } : {}),
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
      // The request's clock, not the ranker's. Ranking is called up to
      // twice per search (the visibility backfill re-assembles from the
      // same candidates), and both passes must judge freshness against
      // the same instant as the time filter and the temporal intent did.
      nowMs: input.nowMs,
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
