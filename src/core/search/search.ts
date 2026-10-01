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
import {
  buildSearchOutcome,
  corpusStatementForEmptyWindow,
  emptyOutcome,
} from "./pipeline/outcome.ts";
import { applyPostRankPhases } from "./pipeline/post-rank.ts";
import { resolveQueryShape } from "./pipeline/query-shape.ts";
import {
  isRelationalArmActive,
  noRelationalArm,
  runRelationalArm,
} from "./pipeline/relational-arm.ts";
import { resolveSearchRequest } from "./pipeline/request.ts";
import { noSecondPass, runSecondPassRecall } from "./pipeline/second-pass.ts";
import { runSemanticLane, type SemanticLaneOutcome } from "./pipeline/semantic-lane.ts";
import { openReadOrSelfHeal } from "./pipeline/store-open.ts";
import { resolveEffectiveWeights } from "./pipeline/weights.ts";
import { detectHybridDegrade } from "./enrich.ts";
import type { CacheProbe } from "./pipeline/cache-slot.ts";
import type { RetrievalDegradationSink } from "./retrieval-trail.ts";
import { RETRIEVAL_DEGRADATION, noteDegradation } from "./retrieval-trail.ts";
import type { FrontmatterCache } from "./result-filters.ts";
import { Store } from "./store.ts";
import type { ResolvedSearchConfig, SearchOptions, SearchOutcome } from "./types.ts";

export { SEARCH_LIMIT_MAX, SEARCH_LIMIT_MIN } from "./pipeline/request.ts";

const CACHE_BYPASSED: CacheProbe = { slot: null, hit: null };

/**
 * The composite hybrid deadline (t_bdc24171): ONE wall-clock budget over
 * the whole hybrid path - embed -> semanticTopK -> rerank -> second pass.
 * The per-lane budgets (the embedding timeout, the rerank timeout) keep
 * firing first on their own lanes; what no lane budget can account for is
 * their SUM and the phases with no budget of their own, and that is what
 * this clock bounds.
 *
 * Enforcement lives here, at the composite entry, because the budget is a
 * property of the whole path and not of any stage: the two async lanes the
 * caller actually waits on (the semantic lane, the post-rank rerank) race
 * the clock and are abandoned past it, and the sync checkpoints between
 * phases skip the budgeted work that has not started yet. When the clock
 * fires, the search completes keyword-only and names it with
 * `RETRIEVAL_DEGRADATION.hybridDeadlineExceeded` - never a stall, never a
 * silent partial.
 */
interface CompositeDeadline {
  /** The configured budget, as resolved onto the request. */
  readonly budgetMs: number;
  /** Absolute fire time, on the request's clock so one clock rules the call. */
  readonly expiresAt: number;
  /**
   * Note the expiry once: the human warning sentence and the typed
   * degradation (with the elapsed/budget detail), plus the same
   * hybrid-degrade umbrella the semantic lane raises when the caller
   * wanted hybrid recall and the lane did not run. Idempotent - several
   * checkpoints can observe one expiry, and the answer names it once.
   */
  fire(): void;
}

function deadlineExpired(deadline: CompositeDeadline | null): boolean {
  return deadline !== null && Date.now() >= deadline.expiresAt;
}

function createCompositeDeadline(input: {
  readonly budgetMs: number | null;
  /** The request's clock: the one `nowMs` every timed decision shares. */
  readonly startMs: number;
  readonly warnings: string[];
  readonly degraded: RetrievalDegradationSink;
  readonly wantSemantic: boolean;
  /** Live keyword-lane size, read when the deadline fires. */
  readonly keywordHitCount: () => number;
}): CompositeDeadline | null {
  if (input.budgetMs === null) return null;
  const budgetMs = input.budgetMs;
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    const elapsedMs = Date.now() - input.startMs;
    input.warnings.push(
      `hybrid deadline ${budgetMs}ms exceeded after ${elapsedMs}ms; returning keyword-only results`,
    );
    noteDegradation(input.degraded, RETRIEVAL_DEGRADATION.hybridDeadlineExceeded, {
      elapsedMs,
      budgetMs,
    });
    const degrade = detectHybridDegrade({
      wantSemantic: input.wantSemantic,
      semanticAttempted: false,
      keywordHitCount: input.keywordHitCount(),
    });
    if (degrade !== null) {
      input.warnings.push(degrade);
      noteDegradation(input.degraded, RETRIEVAL_DEGRADATION.hybridDegraded);
    }
  };
  return { budgetMs, expiresAt: input.startMs + budgetMs, fire };
}

/**
 * Run one async lane under the deadline. A lane that loses the race is
 * abandoned, not awaited - its own lane timeouts settle it in the
 * background - and the deadline's fallback answer is served instead. The
 * attached catch keeps a late rejection from surfacing as unhandled: the
 * degradation already named why the answer is partial, and the abandoned
 * lane's own error is moot past the fire.
 */
async function awaitWithinDeadline<T>(
  work: Promise<T>,
  deadline: CompositeDeadline,
  fallback: () => T,
): Promise<T> {
  void work.catch(() => {});
  const remainingMs = deadline.expiresAt - Date.now();
  if (remainingMs <= 0) {
    deadline.fire();
    return fallback();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineWon = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      deadline.fire();
      resolve(fallback());
    }, remainingMs);
  });
  try {
    return await Promise.race([work, deadlineWon]);
  } finally {
    clearTimeout(timer);
  }
}

/** The semantic-lane outcome when the deadline consumed the lane. */
function emptySemanticLane(): SemanticLaneOutcome {
  return { hits: [], attempted: false, warnings: [], degraded: [] };
}

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
    hybridDeadlineMs,
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
    // The typed sink that rides beside `warnings` (evidence-at-the-boundary,
    // C2): every lane that pushes a sentence below also pushes a code, so a
    // caller can tell an exhausted corpus from a broken embedder without
    // matching on prose.
    const degraded: RetrievalDegradationSink = [];
    // Shared across every frontmatter-reading stage below (Plan 1, 1.3)
    // so a candidate path already read by one stage is not re-read
    // and re-parsed by the next.
    const frontmatterCache: FrontmatterCache = new Map();

    // The composite deadline starts on the request's clock and rides the
    // mutable warning/degradation sinks created just above, so its fire
    // note lands in the same envelope as every lane's own sentence.
    const deadline = createCompositeDeadline({
      budgetMs: hybridDeadlineMs,
      startMs: nowMs,
      warnings,
      degraded,
      wantSemantic: policy.wantSemantic,
      keywordHitCount: () => keywordHits.length,
    });

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
      matchMode: request.matchMode,
    });
    let keywordHits = keywordLane.hits;
    for (const w of keywordLane.warnings) warnings.push(w);
    for (const d of keywordLane.degraded) degraded.push(d);

    const { weightProfile, activeLearned } = resolveEffectiveWeights(
      effectiveConfig,
      keywordLane.plan,
    );

    // Semantic candidates (may be skipped). Under the composite deadline
    // the lane races the clock and is abandoned past it, serving the empty
    // lane outcome - the fire note explains the keyword-only answer.
    const semanticLaneInput = {
      store,
      config: effectiveConfig,
      policy,
      query,
      semanticLaneQuery: shape.semanticLaneQuery,
      limit,
      pathPrefix,
      keywordHitCount: keywordHits.length,
    };
    const semanticLane =
      deadline === null
        ? await runSemanticLane(semanticLaneInput)
        : await awaitWithinDeadline(
            runSemanticLane(semanticLaneInput),
            deadline,
            emptySemanticLane,
          );
    let semanticHits = semanticLane.hits;
    let semanticAttempted = semanticLane.attempted;
    for (const w of semanticLane.warnings) warnings.push(w);
    for (const d of semanticLane.degraded) degraded.push(d);
    // A deadline that fired at (or just past) this boundary voids whatever
    // the lane squeezed in before it: the answer is keyword-only by
    // contract, and the fire note (idempotent) is already in the sinks.
    if (deadlineExpired(deadline)) {
      deadline?.fire();
      semanticHits = [];
      semanticAttempted = false;
    }

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
    const eventTime = createEventTimeResolver(effectiveConfig.vault, frontmatterCache, (path) =>
      store.eventAnchorForPath(path),
    );

    // Second-pass recall (t_ef92dfdc, t_8eb5ca32): evidence-pack mode only,
    // at most one retry, merged into the pool before ranking. The retry is
    // one of the phases the composite deadline bounds (it has no budget of
    // its own), so an expired clock skips it.
    if (deadlineExpired(deadline)) deadline?.fire();
    const twoPassActive =
      opts.evidencePack === true &&
      effectiveConfig.recall.twoPassEnabled &&
      !deadlineExpired(deadline);
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
      // Nothing to rank, so this answer owes an explanation: the lanes
      // either named why, or the corpus statement does.
      const corpus = await corpusStatementForEmptyWindow(() => effectiveConfig, 0, degraded);
      return finalize(
        emptyOutcome({
          store,
          opts,
          query,
          pathPrefix,
          warnings,
          routedSurface,
          degraded,
          corpus,
        }),
      );
    }

    const hydrated = store.hydrateChunks(idsList);

    if (timeRange !== null) {
      const inRange = filterCandidatesInRange({
        hydrated,
        keywordHits,
        semanticHits,
        timeRange,
        validityWindowFor: eventTime.validityWindowFor,
        inferredEventTimeSourceFor: eventTime.inferredEventTimeSourceFor,
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
      degraded,
      weightProfile,
      sessionFocus,
      semanticEnabled: policy.wantSemantic && semanticAttempted,
      structured: shape.structured,
      frontmatterCache,
      timeRange,
      temporalIntent,
      declaredEventTimeMs: eventTime.declaredEventTimeMs,
      limit,
      nowMs,
    });

    // Post-rank phases, under the composite deadline: the rerank lane is
    // the last budgeted caller wait on the composite path, so it races the
    // same clock and, past the deadline, the pool is served in the
    // heuristic order it already had - a named partial, not a stall.
    const postRankInput = {
      store,
      config: effectiveConfig,
      opts,
      query,
      pool,
      structured: shape.structured,
      frontmatterCache,
    };
    const postRank =
      deadline === null
        ? await applyPostRankPhases(postRankInput)
        : await awaitWithinDeadline(applyPostRankPhases(postRankInput), deadline, () => ({
            results: pool,
            trustReceipts: null,
            warnings: [],
          }));
    for (const w of postRank.warnings) warnings.push(w);

    // The pool the window is cut from (task F). `postRank.results` is the
    // last stage that can still add, drop or re-order a candidate, so its
    // length is the honest answer to "how many did you rank before
    // handing me these" - reported inline as `total`.
    const poolSize = postRank.results.length;

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

    // The window can be empty even though candidates were ranked - a scope
    // filter or a relevance floor may have taken every row - so the same
    // question is asked here as on the zero-candidate path above.
    const corpus = await corpusStatementForEmptyWindow(
      () => effectiveConfig,
      results.length,
      degraded,
    );

    // A decision-model fallback (degraded, inactive or skipped) is the
    // heuristic order under a key that promises the configured one: serve
    // it, but never cache it.
    const emit = postRank.decisionFallback === true ? (o: SearchOutcome) => o : finalize;
    return emit(
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
        poolSize,
        degraded,
        corpus,
        ...(postRank.decisionModel?.answerable !== undefined
          ? { decisionModel: { answerable: postRank.decisionModel.answerable } }
          : {}),
      }),
    );
  } finally {
    await store.close();
  }
}
