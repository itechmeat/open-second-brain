/**
 * Public search query: orchestrates FTS5, semantic vector search, link
 * + recency boosts, and the keyword-only fallback policy.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §7, §9.
 *
 * This module is the pipeline itself: every stage lives in `./pipeline/`
 * with its own input and output type, and each stage's opt-in gate is
 * visible here, at the call site. The function is async because semantic
 * search requires an HTTP call (the provider embeds the query).
 * Keyword-only paths stay sync inside the store but the public surface
 * stays uniform.
 */

import { assembleRankedResults } from "./pipeline/assemble.ts";
import { decorateFinalResults } from "./pipeline/attribution.ts";
import { isCacheEligible, persistCachedOutcome, probeQueryCache } from "./pipeline/cache-slot.ts";
import { collectCandidateSignals } from "./pipeline/candidate-signals.ts";
import { createEventTimeResolver, filterCandidatesInRange } from "./pipeline/event-time.ts";
import { runKeywordLane } from "./pipeline/keyword-lane.ts";
import { buildSearchOutcome, emptyOutcome } from "./pipeline/outcome.ts";
import { applyPostRankPhases } from "./pipeline/post-rank.ts";
import { resolveQueryShape } from "./pipeline/query-shape.ts";
import {
  isRelationalArmActive,
  noRelationalArm,
  runRelationalArm,
} from "./pipeline/relational-arm.ts";
import { resolveSearchRequest } from "./pipeline/request.ts";
import { noSecondPass, runSecondPassRecall } from "./pipeline/second-pass.ts";
import { runSemanticLane } from "./pipeline/semantic-lane.ts";
import { openReadOrSelfHeal } from "./pipeline/store-open.ts";
import { resolveEffectiveWeights } from "./pipeline/weights.ts";
import type { CacheProbe } from "./pipeline/cache-slot.ts";
import type { FrontmatterCache } from "./result-filters.ts";
import { Store } from "./store.ts";
import type { ResolvedSearchConfig, SearchOptions, SearchOutcome } from "./types.ts";

export { SEARCH_LIMIT_MAX, SEARCH_LIMIT_MIN } from "./pipeline/request.ts";

const CACHE_BYPASSED: CacheProbe = { slot: null, hit: null };

export async function search(
  config: ResolvedSearchConfig,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  const request = resolveSearchRequest(config, opts);
  // The resolved knob tuple (recall profile / self-tuning) replaces the
  // caller's config for the rest of the pipeline; `query` is the RESIDUAL
  // text, with any time directive already stripped into `temporalIntent`.
  const {
    config: effectiveConfig,
    query,
    limit,
    pathPrefix,
    policy,
    sessionFocus,
    nowMs,
    timeRange,
    temporalIntent,
  } = request;

  // Read-only origins (cross-vault search) disable self-healing: a
  // rebuild would write an index INTO the external vault. Default
  // (selfHeal absent) keeps the legacy heal-and-retry behaviour.
  const store =
    opts.selfHeal === false
      ? await Store.open(effectiveConfig, { mode: "read" })
      : await openReadOrSelfHeal(effectiveConfig);
  try {
    const warnings: string[] = [];
    // Shared across every frontmatter-reading stage below (Plan 1, 1.3)
    // so a candidate path already read by one stage is not re-read
    // and re-parsed by the next.
    const frontmatterCache: FrontmatterCache = new Map();

    const shape = resolveQueryShape({
      store,
      vault: effectiveConfig.vault,
      query,
      structuredQuery: opts.structuredQuery,
      expandActive: request.expandActive,
      nowMs,
      temporalIntent,
    });
    // Summary-search router (t_7b96f242): a per-query structural decision,
    // independent of results, so it is resolved once here and echoed on
    // every outcome below. `default` is omitted from the outcome, keeping
    // the generic-surface response byte-identical to today.
    const routedSurface = shape.basePlan.surface;

    // Persistent query cache (v0.20.0): opt-in. A hit returns the
    // previously computed outcome; generation changes (embedding change or
    // content reindex) and TTL expiry invalidate it. The write-back is
    // best-effort.
    const cache = isCacheEligible(effectiveConfig, timeRange, temporalIntent)
      ? probeQueryCache({
          store,
          config: effectiveConfig,
          opts,
          limit,
          policy,
          sessionFocus,
          tuned: request.tuned,
          planHash: shape.basePlan.planHash,
        })
      : CACHE_BYPASSED;
    if (cache.hit !== null) return cache.hit;
    const finalize = (outcome: SearchOutcome): SearchOutcome => {
      if (cache.slot !== null) persistCachedOutcome(store, cache.slot, outcome);
      return outcome;
    };

    // Keyword candidates, with the plan the synonym step may have re-built.
    const keywordLane = runKeywordLane({
      store,
      recall: effectiveConfig.recall,
      query,
      keywordQuery: shape.keywordQuery,
      structuredIntent: shape.structured?.intent,
      surfaceVocabulary: shape.surfaceVocabulary,
      nowMs,
      temporalIntent,
      basePlan: shape.basePlan,
      limit,
      pathPrefix,
    });
    let keywordHits = keywordLane.hits;
    for (const w of keywordLane.warnings) warnings.push(w);

    const { weightProfile, activeLearned } = resolveEffectiveWeights(
      effectiveConfig,
      keywordLane.plan,
    );

    // Semantic candidates (may be skipped).
    const semanticLane = await runSemanticLane({
      store,
      config: effectiveConfig,
      policy,
      query,
      semanticLaneQuery: shape.semanticLaneQuery,
      limit,
      pathPrefix,
      keywordHitCount: keywordHits.length,
    });
    let semanticHits = semanticLane.hits;
    for (const w of semanticLane.warnings) warnings.push(w);

    // Typed-edge relational arm (t_09b7ccea): a fourth RRF arm, engaged
    // only for a relationship-shaped query under rrf fusion.
    const relational = isRelationalArmActive(effectiveConfig, opts)
      ? runRelationalArm(store, effectiveConfig.vault, query)
      : noRelationalArm();

    // Hydrate.
    const allChunkIds = new Set<number>();
    for (const h of keywordHits) allChunkIds.add(h.chunkId);
    for (const h of semanticHits) allChunkIds.add(h.chunkId);
    for (const id of relational.rankedChunkIds) allChunkIds.add(id);

    // One event-time resolver for the whole call: the targeted-retry
    // coverage gate, the hard time filter, the temporal bridge and the
    // ranker's declared-event-time map all judge a page the same way.
    const eventTime = createEventTimeResolver(effectiveConfig.vault, frontmatterCache);

    // Second-pass recall (t_ef92dfdc, t_8eb5ca32): evidence-pack mode only,
    // at most one retry, merged into the pool before ranking.
    const twoPassActive = opts.evidencePack === true && effectiveConfig.recall.twoPassEnabled;
    const retry = twoPassActive
      ? runSecondPassRecall({
          store,
          query,
          limit,
          pathPrefix,
          timeRange,
          validityWindowFor: eventTime.validityWindowFor,
          keywordHits,
          chunkIds: allChunkIds,
          ids: Array.from(allChunkIds),
        })
      : noSecondPass({ keywordHits, ids: Array.from(allChunkIds) });
    keywordHits = retry.keywordHits;
    for (const w of retry.warnings) warnings.push(w);
    const idsList = retry.ids;

    if (idsList.length === 0) {
      return finalize(emptyOutcome({ store, opts, query, pathPrefix, warnings, routedSurface }));
    }

    const hydrated = store.hydrateChunks(idsList);

    if (timeRange !== null) {
      const inRange = filterCandidatesInRange({
        hydrated,
        keywordHits,
        semanticHits,
        timeRange,
        validityWindowFor: eventTime.validityWindowFor,
      });
      keywordHits = inRange.keywordHits;
      semanticHits = inRange.semanticHits;
      for (const w of inRange.warnings) warnings.push(w);
    }

    const signals = collectCandidateSignals({
      store,
      config: effectiveConfig,
      ids: idsList,
      hydrated,
      query,
      frontmatterCache,
      temporalIntentActive: temporalIntent !== null,
      declaredEventTimeMs: eventTime.declaredEventTimeMs,
    });

    const pool = assembleRankedResults({
      store,
      config: effectiveConfig,
      opts,
      keywordHits,
      semanticHits,
      hydrated,
      signals,
      relationalRankedChunkIds: relational.rankedChunkIds,
      weightProfile,
      sessionFocus,
      semanticEnabled: policy.wantSemantic && semanticLane.attempted,
      structured: shape.structured,
      frontmatterCache,
      timeRange,
      temporalIntent,
      declaredEventTimeMs: eventTime.declaredEventTimeMs,
      limit,
    });

    const postRank = await applyPostRankPhases({
      store,
      config: effectiveConfig,
      opts,
      query,
      pool,
      structured: shape.structured,
      frontmatterCache,
    });
    for (const w of postRank.warnings) warnings.push(w);

    const results = decorateFinalResults({
      store,
      results: postRank.results.slice(0, limit),
      structured: shape.structured,
      activeLearned,
      canonicalMatchByChunk: signals.canonicalMatchByChunk,
      canonicalSourceIds: signals.canonicalSourceIds,
      secondPass: retry.secondPass,
      targetedChunkIds: retry.targetedChunkIds,
      relationalReach: relational.reachByChunk,
    });

    return finalize(
      buildSearchOutcome({
        store,
        config: effectiveConfig,
        opts,
        query,
        pathPrefix,
        results,
        warnings,
        secondPass: retry.secondPass,
        routedSurface,
        trustReceipts: postRank.trustReceipts,
        frontmatterCache,
      }),
    );
  } finally {
    await store.close();
  }
}
