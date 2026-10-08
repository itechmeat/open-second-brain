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
  withIndexStale,
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
import { isAbortError } from "./embeddings/http-util.ts";
import type { CacheProbe } from "./pipeline/cache-slot.ts";
import type { RetrievalDegradationSink } from "./retrieval-trail.ts";
import { RETRIEVAL_DEGRADATION, noteDegradation } from "./retrieval-trail.ts";
import { indexAgeSeconds, maybeFreshenIndex } from "./freshen.ts";
import { LAST_INDEXED_AT_STATE_KEY } from "./store/state.ts";
import type { FrontmatterCache } from "./result-filters.ts";
import { Store } from "./store.ts";
import type { ResolvedSearchConfig, SearchOptions, SearchOutcome } from "./types.ts";

export { SEARCH_LIMIT_MAX, SEARCH_LIMIT_MIN } from "./pipeline/request.ts";

const CACHE_BYPASSED: CacheProbe = { slot: null, hit: null };

/** Lead of the warning that names an abandoned lane's late, non-abort failure. */
const ABANDONED_LANE_FAILURE_PREFIX = "hybrid deadline: an abandoned lane failed after the answer:";

/**
 * The composite hybrid deadline (t_bdc24171): ONE wall-clock budget over
 * the whole hybrid path - embed -> semanticTopK -> rerank -> second pass.
 * The per-lane budgets (the embedding timeout, the rerank timeout) keep
 * firing first on their own lanes; what no lane budget can account for is
 * their SUM and the phases with no budget of their own, and that is what
 * this clock bounds. When it fires it also aborts its signal, which the
 * semantic lane's query embed and the cross-encoder request carry, so an
 * abandoned lane stops its provider request instead of running on.
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
   * Aborts {@link signal}.
   */
  fire(): void;
  /** True once {@link fire} ran: the answer is a degraded one. */
  hasFired(): boolean;
  /** Aborted on fire; handed to every provider request the clock bounds. */
  readonly signal: AbortSignal;
  /**
   * Name a failure an abandoned lane raised after the answer was served.
   * The deadline's own abort is recognised by name and needs no note (the
   * degradation already says the lane was cut); any other error is
   * appended to the warnings, never dropped.
   */
  noteAbandonedFailure(error: unknown): void;
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
  const controller = new AbortController();
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    controller.abort();
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
  const noteAbandonedFailure = (error: unknown): void => {
    if (isAbortError(error)) return;
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    input.warnings.push(`${ABANDONED_LANE_FAILURE_PREFIX} ${name}: ${message}`);
  };
  return {
    budgetMs,
    expiresAt: input.startMs + budgetMs,
    fire,
    hasFired: () => fired,
    signal: controller.signal,
    noteAbandonedFailure,
  };
}

/**
 * Run one async lane under the deadline. A lane whose clock has already
 * run out is never started. A lane that loses the race is abandoned, not
 * awaited: the fire aborts the signal its provider request carries, and
 * the deadline's fallback answer is served instead. A rejection that
 * arrives after that is handed to the deadline, which recognises its own
 * abort by name and names any other failure in the warnings.
 */
async function awaitWithinDeadline<T>(
  start: () => Promise<T>,
  deadline: CompositeDeadline,
  fallback: () => T,
): Promise<T> {
  const remainingMs = deadline.expiresAt - Date.now();
  if (remainingMs <= 0) {
    deadline.fire();
    return fallback();
  }
  const work = start();
  let abandoned = false;
  // Before the fire the race below rethrows the rejection to the caller;
  // only an abandoned lane's rejection is the deadline's to name.
  void work.catch((error: unknown) => {
    if (abandoned) deadline.noteAbandonedFailure(error);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineWon = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      abandoned = true;
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
    // Freshen on read: an index older than the interval starts one
    // background incremental run (never into a read-only origin); this
    // answer comes from the index as it is. A badly stale index is named
    // on the trail whether or not a run could start, at read time on every
    // answer, cache hits included, and never in the cached row.
    const lastIndexedAt = store.getState(LAST_INDEXED_AT_STATE_KEY);
    maybeFreshenIndex(effectiveConfig, {
      lastIndexedAt,
      readOnly: opts.selfHeal === false,
      nowMs,
      ...(opts.freshenSpawn !== undefined ? { spawn: opts.freshenSpawn } : {}),
    });
    const indexAge = indexAgeSeconds(lastIndexedAt, nowMs);
    const served = (outcome: SearchOutcome): SearchOutcome => withIndexStale(outcome, indexAge);
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
    if (cache.hit !== null) return served(cache.hit);
    // A deadline-degraded answer is keyword-only under a key that promises
    // the hybrid one: serve it, but never cache it. A spend-gated one is
    // the same, and the key carries no gate or price either, so a cached
    // refusal would outlive the operator's price declaration. A query cut
    // to its window is cached: the key carries the effective window and
    // the query prefix, so a declared or changed window re-keys it.
    const finalize = (outcome: SearchOutcome): SearchOutcome => {
      const configBound = degraded.some(
        (d) => d.code === RETRIEVAL_DEGRADATION.semanticCostUnpriced,
      );
      if (cache.slot !== null && deadline?.hasFired() !== true && !configBound) {
        persistCachedOutcome(store, cache.slot, outcome);
      }
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
      ...(opts.transportReach !== undefined ? { transportReach: opts.transportReach } : {}),
    };
    const semanticLane =
      deadline === null
        ? await runSemanticLane(semanticLaneInput)
        : await awaitWithinDeadline(
            () => runSemanticLane({ ...semanticLaneInput, signal: deadline.signal }),
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
      const corpus = await corpusStatementForEmptyWindow(
        () => effectiveConfig,
        0,
        degraded,
        opts.transportReach,
      );
      return served(
        finalize(
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
        ),
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

    // Post-rank phases, under the composite deadline: the cross-encoder
    // call is the last budgeted caller wait on the composite path, so it
    // alone races the same clock. Past the deadline the reader step serves
    // the order it was handed - a named partial, not a stall - and the
    // exclusions, reach filter, trust gate, supersede fade, relation
    // polarity and reinforce still run on it.
    const postRank = await applyPostRankPhases({
      store,
      config: effectiveConfig,
      opts,
      query,
      pool,
      structured: shape.structured,
      frontmatterCache,
      nowMs,
      ...(deadline !== null
        ? {
            signal: deadline.signal,
            raceRerank: (work, fallback) => awaitWithinDeadline(work, deadline, fallback),
          }
        : {}),
    });
    for (const w of postRank.warnings) warnings.push(w);
    for (const d of postRank.degraded) degraded.push(d);

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
      opts.transportReach,
    );

    // A decision-model fallback (degraded, inactive or skipped) and a
    // failed cross-encoder request are both the heuristic order under a
    // key that promises the reranked one: serve them, but never cache
    // them, so a transient endpoint failure is retried by the next
    // identical query (the deadline case is `finalize`'s own rule).
    const rerankUnavailable = postRank.degraded.some(
      (d) => d.code === RETRIEVAL_DEGRADATION.rerankProviderUnavailable,
    );
    const emit =
      postRank.decisionFallback === true || rerankUnavailable ? (o: SearchOutcome) => o : finalize;
    return served(
      emit(
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
      ),
    );
  } finally {
    await store.close();
  }
}
