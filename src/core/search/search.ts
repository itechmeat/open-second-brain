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
import {
  isCacheEligible,
  iterativeTokenSpent,
  mintIterativeToken,
  readIterativeTokenRecord,
  claimIterativeToken,
  releaseIterativeToken,
  persistCachedOutcome,
  probeQueryCache,
} from "./pipeline/cache-slot.ts";
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
import { resolvePoolFilters } from "./pipeline/pool-filters.ts";
import { resolveQueryShape } from "./pipeline/query-shape.ts";
import {
  isRelationalArmActive,
  noRelationalArm,
  runRelationalArm,
} from "./pipeline/relational-arm.ts";
import { resolveSearchRequest } from "./pipeline/request.ts";
import { SEARCH_TRUST_GATE_MODE } from "../brain/trust/retrieval-gate.ts";
import {
  resolveIterativeRequest,
  runDeciderRound,
  runIterativeRecall,
} from "./pipeline/iterative-recall.ts";
import { DeciderStepError, nonceRoundToken, randomRoundNonce } from "./decider-step.ts";
import { ResponseCheckError } from "../brain/response-checks.ts";
import { ResponseShapeError } from "../brain/response-shape.ts";
import { resolveKindFilter } from "./property-pushdown.ts";
import { noSecondPass, runSecondPassRecall } from "./pipeline/second-pass.ts";
import { runSemanticLane, type SemanticLaneOutcome } from "./pipeline/semantic-lane.ts";
import type { SemanticEmbedTiming } from "./semantic-phase.ts";
import { openReadOrSelfHeal } from "./pipeline/store-open.ts";
import { resolveEffectiveWeights } from "./pipeline/weights.ts";
import { detectHybridDegrade } from "./enrich.ts";
import { isAbortError } from "./embeddings/http-util.ts";
import type { CacheProbe } from "./pipeline/cache-slot.ts";
import type { RetrievalDegradationSink } from "./retrieval-trail.ts";
import { RETRIEVAL_DEGRADATION, noteDegradation } from "./retrieval-trail.ts";
import { indexAgeSeconds, maybeFreshenIndex } from "./freshen.ts";
import { LAST_INDEXED_AT_STATE_KEY } from "./store/state.ts";
import { isPathReadableAtReach, type FrontmatterCache } from "./result-filters.ts";
import { Store } from "./store.ts";
import { SearchError } from "./types.ts";
import type { BrainSearchResult } from "./search-result.ts";
import type {
  IterativeStopReason,
  ResolvedSearchConfig,
  SearchOptions,
  SearchOutcome,
  SearchOutcomeIterative,
} from "./types.ts";

export { SEARCH_LIMIT_MAX, SEARCH_LIMIT_MIN } from "./pipeline/request.ts";

const CACHE_BYPASSED: CacheProbe = { slot: null, hit: null };

/**
 * The committed decider evidence's preference over the final window
 * (recall-quality wave, M3): the ranked prefix keeps its head, and the
 * pinned ids that ranked OUTSIDE the `limit` window displace the window's
 * tail - so a core-evidence chunk the ranking would have dropped still
 * reaches the answer, while every pinned id that never survived ranking
 * (a gate exclusion, a reach withdrawal) is silently not pinned: the
 * preference only ever promotes candidates the ranked pool actually
 * holds, in ranked order. Deterministic, and a no-op whenever the ranked
 * pool already covers the evidence.
 */
function pinCommittedEvidence(
  ranked: ReadonlyArray<BrainSearchResult>,
  limit: number,
  evidenceIds: ReadonlyArray<number>,
): ReadonlyArray<BrainSearchResult> {
  const window = ranked.slice(0, limit);
  if (evidenceIds.length === 0 || window.length === 0) return window;
  const inWindow = new Set(window.map((row) => row.chunkId));
  const pinned = new Set(evidenceIds);
  const missing = ranked.filter((row) => pinned.has(row.chunkId) && !inWindow.has(row.chunkId));
  if (missing.length === 0) return window;
  const keep = Math.max(0, limit - missing.length);
  return [...window.slice(0, keep), ...missing].slice(0, limit);
}

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
 *
 * Exported for the overlap seam's tests, which build a real clock and pin
 * the abandoned-lane sentence byte for byte.
 */
export interface CompositeDeadline {
  /** The configured budget, as resolved onto the request. */
  readonly budgetMs: number;
  /** Absolute fire time, on the request's clock so one clock rules the call. */
  readonly expiresAt: number;
  /** The request's clock, readable: every expiry check reads through it. */
  readonly clock: () => number;
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
  return deadline !== null && deadline.clock() >= deadline.expiresAt;
}

export function createCompositeDeadline(input: {
  readonly budgetMs: number | null;
  /** The request's clock: the one `nowMs` every timed decision shares. */
  readonly startMs: number;
  /** The request's clock, readable: every check below reads through it. */
  readonly clock: () => number;
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
    const elapsedMs = input.clock() - input.startMs;
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
    clock: input.clock,
    fire,
    hasFired: () => fired,
    signal: controller.signal,
    noteAbandonedFailure,
  };
}

/**
 * The clock members the deadline-bounded lanes read. The full
 * {@link CompositeDeadline} satisfies it; the narrow shape keeps the
 * lane seams honest about what they touch and unit-testable without the
 * whole machinery.
 */
export interface LaneDeadline {
  /** Absolute fire time, on the request's clock. */
  readonly expiresAt: number;
  /**
   * Read the request's clock: the port the resolved request hands the
   * call, so a lane seam never reads the wall clock for itself.
   */
  readonly clock: () => number;
  /** Note the expiry (once) and abort the signal the lanes carry. */
  fire(): void;
  /** Name an abandoned lane's late, non-abort failure. */
  noteAbandonedFailure(error: unknown): void;
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
  deadline: LaneDeadline,
  fallback: () => T,
  hooks?: { readonly onRaceArmed?: () => void },
): Promise<T> {
  const remainingMs = deadline.expiresAt - deadline.clock();
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
  // From here the race owns the lane's rejection: a join seam that also
  // attached a handler at start time defuses it (never a double note).
  hooks?.onRaceArmed?.();
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

/**
 * The hidden window: the intersection of the embed interval and the
 * keyword interval, floored at 0. Extracted as a pure function because a
 * real overlapped run can legitimately measure zero - a small corpus lets
 * the synchronous FTS lane finish inside the wall clock's resolution - so
 * no integration run can pin the arithmetic itself. The unit tests over
 * this function are the exactness pin (swapped bounds, inverted order);
 * the integration suite only pins that the wiring carries a sane value.
 */
export function overlappedEmbedMs(
  embedStartMs: number,
  embedEndMs: number,
  keywordStartMs: number,
  keywordEndMs: number,
): number {
  return Math.max(0, Math.min(embedEndMs, keywordEndMs) - Math.max(embedStartMs, keywordStartMs));
}

/**
 * A lane started BEFORE the keyword lanes (recall-lane-latency): the
 * query embed is the one caller wait the keyword work can hide, so it is
 * put in flight here and joined where the serial await stood. The embed
 * request leaves in the caller's own tick; the keyword lanes then run to
 * completion synchronously while the round trip is outstanding.
 *
 * Two rules travel with the seam:
 *
 *   - The never-start rule moves to the start site: a clock that has
 *     already run out starts no embed at all. The FIRE waits for the
 *     join: at the start site the keyword lanes have not run, and a fire
 *     there would snapshot the empty keyword pool into the degrade
 *     decision, losing the umbrella sentence the serial contract emits.
 *     The join's never-start arm (inside {@link awaitWithinDeadline})
 *     runs after the keyword lanes merged, so the same rule fires there
 *     against the real pool - the snapshot point the serial pipeline had.
 *   - The rejection handler attaches at START, not at join. Between the
 *     two stand the synchronous keyword lanes, and a throw there unwinds
 *     the call with the embed still in flight. With a deadline the
 *     stranded lane's failure is the deadline's to name; without one the
 *     keyword step's own error is what the caller sees, and the handler
 *     only keeps the stranded rejection from crashing the process. Once
 *     the race inside {@link awaitWithinDeadline} arms its own catch it
 *     owns the rejection (rethrow before the fire, note after it) and
 *     this handler defuses - but only then: a failure landing in the
 *     start-to-join window, including after a join-time fire, stays the
 *     deadline's to name.
 */
export interface SemanticLaneJoin<T> {
  /** Resolve the lane: its outcome, the fallback, or the lane's own error. */
  join(): Promise<T>;
}

export function startSemanticLane<T>(input: {
  /** Starts the lane; called in the caller's tick unless the clock ran out. */
  readonly start: () => Promise<T>;
  /** The composite clock; null runs the lane unbounded. */
  readonly deadline: LaneDeadline | null;
  /** The empty lane the deadline serves when it consumed the lane. */
  readonly fallback: () => T;
}): SemanticLaneJoin<T> {
  const deadline = input.deadline;
  if (deadline !== null && deadline.expiresAt - deadline.clock() <= 0) {
    // Never start the embed - but never fire here either: the keyword
    // lanes have not run, and the degrade decision must read the pool
    // they populated. Leave the fire to the join's never-start arm.
    return {
      join: () =>
        awaitWithinDeadline(
          () => {
            throw new Error(
              "the semantic lane never started: the hybrid deadline had already expired",
            );
          },
          deadline,
          input.fallback,
        ),
    };
  }
  const work = input.start();
  let raced = false;
  void work.catch((error: unknown) => {
    if (raced || deadline === null) return;
    deadline.noteAbandonedFailure(error);
  });
  return {
    join: async (): Promise<T> => {
      if (deadline === null) {
        raced = true;
        return await work;
      }
      return await awaitWithinDeadline(() => work, deadline, input.fallback, {
        onRaceArmed: () => {
          raced = true;
        },
      });
    },
  };
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
    clock,
    timeRange,
    temporalIntent,
    hybridDeadlineMs,
  } = request;

  // Pushdown resolution (recall-quality, C4). The chunk kind and the
  // promoted half of the property map are answered by the lanes' SQL;
  // both resolve up front, beside the other request-level validation, so
  // invalid input fails before the index opens. The fallback property
  // half is resolved inside the assembly's own `resolvePoolFilters`, from
  // the same split.
  const kind = resolveKindFilter(opts.kind);
  const { pushdown } = resolvePoolFilters(opts);

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
      clock,
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

    // Iterative recall request resolution (recall-quality wave): hoisted
    // ABOVE the cache probe because a commit call must refuse an
    // already-spent round token before any cached commit response could
    // be served - the refusal is the single-use contract, and a warm row
    // must not bypass it.
    const iterativeRequest = resolveIterativeRequest(opts, effectiveConfig);
    if (
      iterativeRequest?.phase === "commit" &&
      iterativeTokenSpent(store, effectiveConfig, opts.iterativeToken!, nowMs)
    ) {
      throw new SearchError(
        "INVALID_INPUT",
        `iterative commit refused (token_used): round token ${JSON.stringify(opts.iterativeToken)} was already spent; a round token is single use`,
      );
    }

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
    if (cache.hit !== null) {
      // A cached PLAN row carries the round token its plan call minted.
      // When that token was already spent by a commit, the row is stale
      // for purpose - serving it would hand the caller a dead token and
      // lock the retry out until the TTL - so the hit is discarded and
      // the plan recomputes (and mints fresh). Every other hit serves as
      // usual; a commit row never carries a token, and the entry refusal
      // above already arbitrates replays.
      const cachedMarker = cache.hit.iterative;
      const cachedToken = cachedMarker?.phase === "needs-llm-step" ? cachedMarker.token : undefined;
      if (
        cachedToken === undefined ||
        !iterativeTokenSpent(store, effectiveConfig, cachedToken, nowMs)
      ) {
        return served(cache.hit);
      }
    }
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

    // Semantic candidates (may be skipped). The lane starts BEFORE the
    // keyword lanes (recall-lane-latency): its query embed is the one
    // caller wait the keyword work can hide, so it is put in flight here,
    // in this tick, and joined where the serial await stood below. The
    // keyword pool size rides the lane's lazy supplier - at start time the
    // keyword lanes have not run yet, and the lane reads the pool they
    // produced when it completes, the same snapshot the serial pipeline
    // captured at the join. Under the composite deadline the lane races
    // the clock from the join (the remaining budget is computed there, so
    // an early start neither starts the clock sooner nor extends it), the
    // deadline's signal rides in the lane input so a fire aborts the
    // in-flight embed, and a clock that already ran out starts nothing.
    let keywordHits: ReturnType<typeof runKeywordLane>["hits"] = [];
    // Per-call lane timing (recall-lane-latency): the record is owned
    // here, stamped by the phase around the embed, and folded into one
    // sink call at the join. Never an outcome field - the query cache
    // persists whole outcomes, so a field there would freeze this call's
    // timings into every cached row served afterwards.
    const laneTimingSink = opts.laneTiming;
    const embedTiming: SemanticEmbedTiming = { clock };
    const semanticLaneInput = {
      store,
      config: effectiveConfig,
      policy,
      query,
      semanticLaneQuery: shape.semanticLaneQuery,
      limit,
      pathPrefix,
      ...(kind !== undefined ? { kind } : {}),
      ...(pushdown !== null ? { pushdown } : {}),
      keywordHitCount: () => keywordHits.length,
      ...(opts.transportReach !== undefined ? { transportReach: opts.transportReach } : {}),
      ...(laneTimingSink !== undefined ? { timing: embedTiming } : {}),
    };
    const semanticLaneJoin = startSemanticLane({
      deadline,
      fallback: emptySemanticLane,
      start: () =>
        runSemanticLane(
          deadline === null ? semanticLaneInput : { ...semanticLaneInput, signal: deadline.signal },
        ),
    });

    // Keyword candidates, with the plan the synonym step may have re-built.
    // The interval stamps read the request's clock port, never the wall
    // clock directly - the rank-clock census pins the read site.
    const keywordStartMs = clock();
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
      ...(kind !== undefined ? { kind } : {}),
      ...(pushdown !== null ? { pushdown } : {}),
      matchMode: request.matchMode,
    });
    keywordHits = keywordLane.hits;
    for (const w of keywordLane.warnings) warnings.push(w);
    for (const d of keywordLane.degraded) degraded.push(d);

    const { weightProfile, activeLearned } = resolveEffectiveWeights(
      effectiveConfig,
      keywordLane.plan,
    );
    // The hidden window the join waits through includes the weights
    // resolution, so the keyword interval ends here, not at the lane return.
    const keywordEndMs = clock();

    // The join, where the serial await stood: the keyword lanes ran to
    // completion above while the embed round trip was outstanding. Their
    // warnings merged first, and the lane's merge here keeps the same
    // keyword-before-semantic order the serial pipeline emitted.
    const semanticLane = await semanticLaneJoin.join();
    // One sink call at the join, on both deadline arms: the intervals and
    // their intersection, zero whenever no embed interval was stamped
    // (keyword-only, or a pre-flight refusal left no stamps). The start
    // is the dispatch report when the provider gave one, and the pre-call
    // fallback otherwise (a provider that never reports dispatches keeps
    // its whole-awaited-call interval). An embed that ran and was
    // discarded still reports its real interval.
    if (laneTimingSink !== undefined) {
      const embedStartMs = embedTiming.embedStartMs ?? embedTiming.preCallStartMs;
      const embedEndMs = embedTiming.embedEndMs;
      laneTimingSink({
        ...(embedStartMs !== undefined ? { embedStartMs } : {}),
        ...(embedEndMs !== undefined ? { embedEndMs } : {}),
        keywordStartMs,
        keywordEndMs,
        overlappedMs:
          embedStartMs !== undefined && embedEndMs !== undefined
            ? overlappedEmbedMs(embedStartMs, embedEndMs, keywordStartMs, keywordEndMs)
            : 0,
        attempted: semanticLane.attempted,
      });
    }
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
    // only for a relationship-shaped query under rrf fusion. The deepened
    // traversal rides the same composite clock every other phase answers
    // to - the walk abandons its frontier once the deadline has fired -
    // and gates its ordered provenance paths at the caller's transport
    // reach and owner scope (an absent reach resolves to the same remote
    // default the row-level filters apply, so provenance never names a
    // page those rows withhold). The
    // width budgets need no threading: the arm resolves them itself from
    // the same env and the config file this call's resolution read (the
    // resolved config's path, threaded through). With the arm off this
    // whole expression is `noRelationalArm()` exactly as before.
    const relational = isRelationalArmActive(effectiveConfig, opts)
      ? runRelationalArm(store, effectiveConfig.vault, query, {
          configPath: effectiveConfig.configPath,
          // One posture for the edge gate and the page gate: the mode the
          // effective config resolved, overrides included.
          trustGateMode: effectiveConfig.recall.searchTrustGateMode ?? SEARCH_TRUST_GATE_MODE.off,
          ...(deadline !== null ? { isExpired: () => deadlineExpired(deadline) } : {}),
          ...(opts.transportReach !== undefined ? { reach: opts.transportReach } : {}),
          // The caller's owner scope gates the provenance path nodes the
          // same way the row-level filters gate content rows: a
          // reach-readable node another agent owns is omitted from the
          // ordered path, never named and never counted in the trail.
          ...(opts.agentScope !== undefined ? { agentScope: opts.agentScope } : {}),
        })
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
          ...(kind !== undefined ? { kind } : {}),
          ...(pushdown !== null ? { pushdown } : {}),
          timeRange,
          validityWindowFor: eventTime.validityWindowFor,
          keywordHits,
          chunkIds: allChunkIds,
          ids: Array.from(allChunkIds),
        })
      : noSecondPass({ keywordHits, ids: Array.from(allChunkIds) });
    keywordHits = retry.keywordHits;
    for (const w of retry.warnings) warnings.push(w);
    let idsList = retry.ids;

    // Bounded iterative recall (recall-quality wave): with the caller's
    // per-query flag and the operator's knob both on, gap-proposal rounds
    // run past the single second pass over the same pool-merging
    // discipline, bounded by the round cap and the composite deadline the
    // second pass itself answers to. The loop is deterministic and
    // model-free; the caller-executed decider round rides this seam too
    // (decider-step.ts). Flag absent, or knob off, this block is never
    // entered and the pipeline is byte-identical.
    const reachFilterFor = (reach: NonNullable<typeof opts.transportReach>) => {
      return (ids: ReadonlyArray<number>): ReadonlyArray<number> => {
        const hydrated = store.hydrateChunks(ids);
        const indexed = store.indexedVisibilityByPaths([...hydrated.values()].map((c) => c.path));
        return ids.filter((id) => {
          const chunk = hydrated.get(id);
          return (
            chunk !== undefined &&
            isPathReadableAtReach(
              effectiveConfig.vault,
              chunk.path,
              reach,
              frontmatterCache,
              indexed.get(chunk.path),
            )
          );
        });
      };
    };
    let iterativeMarker: SearchOutcomeIterative | null = null;
    // The committed decider evidence (recall-quality wave, M3): carried
    // out of the commit so the final window can prefer it and the marker
    // can name it. Empty on every other leg.
    let committedEvidenceIds: ReadonlyArray<number> = [];
    if (
      iterativeRequest !== null &&
      iterativeRequest.phase === "commit" &&
      deadlineExpired(deadline)
    ) {
      // A commit whose clock died before the block is refused by name,
      // exactly like a commit against moved state: silence here would
      // spend nothing it named and return a plain answer the caller
      // would read as its commit's outcome.
      throw new SearchError(
        "INVALID_INPUT",
        "iterative commit refused: no decider round is pending for this query state; run the plan phase again",
      );
    }
    if (iterativeRequest !== null && !deadlineExpired(deadline)) {
      // The plan phase mints the round token through the registry: a
      // nonce token registered with the pause state's digest, so "spent"
      // means "this plan call" and a second plan for the same query
      // mints a fresh token instead of handing out the already-claimed
      // one. When the registry cannot take the write, the mint reports
      // null and the pause falls back to the deterministic digest token
      // - best-effort by contract, so the loop still works with the
      // cache table unavailable (the fallback validates by re-derivation
      // at commit time instead). The commit leg's replay never mints: it
      // rebuilds the pause only to validate the caller's token against.
      const mintRoundToken =
        iterativeRequest.phase === "plan"
          ? ({
              round,
              pauseDigest,
              deterministicRounds,
              stopReason,
            }: {
              readonly round: number;
              readonly pauseDigest: string;
              readonly deterministicRounds: number;
              readonly stopReason: IterativeStopReason;
            }): string | null => {
              const token = nonceRoundToken(round, randomRoundNonce());
              // The row is the commit leg's replay brief: the digest to
              // validate the replayed state against, and the deterministic
              // round count the replay must run regardless of its own
              // clock.
              return mintIterativeToken(
                store,
                effectiveConfig,
                token,
                { pauseDigest, rounds: deterministicRounds, stopReason },
                nowMs,
              )
                ? token
                : null;
            }
          : undefined;
      // The commit leg reads the plan's mint row before the replay: the
      // digest for the validator, and the recorded round count the replay
      // must run. Null (deterministic fallback token, or a row that aged
      // out) downgrades to re-derivation and the live-clock replay.
      const tokenRecord =
        iterativeRequest.phase === "commit"
          ? readIterativeTokenRecord(store, effectiveConfig, opts.iterativeToken!, nowMs)
          : null;
      const loop = runIterativeRecall({
        store,
        query,
        limit,
        pathPrefix,
        ...(kind !== undefined ? { kind } : {}),
        ...(pushdown !== null ? { pushdown } : {}),
        timeRange,
        validityWindowFor: eventTime.validityWindowFor,
        keywordHits,
        chunkIds: allChunkIds,
        ids: idsList,
        maxRounds: iterativeRequest.maxRounds,
        firstRoundNumber: retry.secondPass !== undefined ? 3 : 2,
        isExpired: () => deadlineExpired(deadline),
        ...(mintRoundToken !== undefined ? { mintRoundToken } : {}),
        ...(tokenRecord?.rounds !== undefined ? { replayRounds: tokenRecord.rounds } : {}),
        ...(opts.transportReach !== undefined && opts.transportReach !== "local"
          ? { filterReachableIds: reachFilterFor(opts.transportReach) }
          : {}),
      });
      keywordHits = loop.keywordHits;
      idsList = loop.ids;
      if (iterativeRequest.phase === "commit") {
        // The pause digest the plan's mint stored for this token: the
        // validator compares it against the replayed state's digest, so
        // a commit whose replay landed on another round or pool is
        // refused as token_mismatch even though the token itself was
        // minted honestly. Undefined (deterministic fallback token, or a
        // row that aged out) downgrades to re-derivation alone.
        const mintedPauseDigest = tokenRecord?.pauseDigest;
        // The deterministic replay reached a state with no pending round
        // (the index moved under the caller between the two calls): the
        // commit is refused rather than executed against a pool its
        // token never named.
        if (loop.pause === null) {
          throw new SearchError(
            "INVALID_INPUT",
            "iterative commit refused: no decider round is pending for this query state; run the plan phase again",
          );
        }
        // The claim, not the entry check, arbitrates single use: two
        // commits racing the same token both pass the entry read, and
        // one atomic insert lets exactly one of them run the round.
        let claimed = false;
        try {
          if (!claimIterativeToken(store, effectiveConfig, opts.iterativeToken!, nowMs)) {
            throw new SearchError(
              "INVALID_INPUT",
              `iterative commit refused (token_used): round token ${JSON.stringify(opts.iterativeToken)} was already claimed; a round token is single use`,
            );
          }
          claimed = true;
          // One call commits at most once, so the in-call spent set the
          // validator sees stays empty; cross-call single use is the
          // claim above.
          const committed = runDeciderRound({
            store,
            query,
            limit,
            pathPrefix,
            ...(kind !== undefined ? { kind } : {}),
            ...(pushdown !== null ? { pushdown } : {}),
            timeRange,
            validityWindowFor: eventTime.validityWindowFor,
            keywordHits,
            chunkIds: allChunkIds,
            pause: loop.pause,
            token: opts.iterativeToken!,
            payload: opts.iterativePayload,
            usedTokens: new Set<string>(),
            ...(mintedPauseDigest !== undefined ? { mintedPauseDigest } : {}),
            priorRounds: loop.rounds,
            ...(opts.transportReach !== undefined && opts.transportReach !== "local"
              ? { filterReachableIds: reachFilterFor(opts.transportReach) }
              : {}),
          });
          keywordHits = committed.keywordHits;
          idsList = committed.ids;
          committedEvidenceIds = committed.evidenceIds;
          iterativeMarker = {
            phase: "final",
            rounds: committed.rounds,
            stopReason: committed.stopReason,
            evidenceIds: committed.evidenceIds,
          };
        } catch (e) {
          if (claimed) releaseIterativeToken(store, opts.iterativeToken!);
          if (e instanceof DeciderStepError) {
            throw new SearchError(
              "INVALID_INPUT",
              `iterative commit refused (${e.code}): ${e.message}`,
            );
          }
          // A payload the validators refused (shape, or a registered
          // semantic rule) is the caller's mistake, named by the same
          // INVALID_INPUT the decider refusals carry: left raw it would
          // escape classification and surface over MCP as an internal
          // error instead of invalid_params. The refusal happens before
          // any pull, so nothing about the round moved.
          if (e instanceof ResponseShapeError || e instanceof ResponseCheckError) {
            throw new SearchError("INVALID_INPUT", `iterative commit refused: ${e.message}`);
          }
          throw e;
        }
      } else if (loop.pause !== null) {
        iterativeMarker = {
          phase: "needs-llm-step",
          round: loop.pause.round,
          token: loop.pause.token,
          llmStep: loop.pause.llmStep,
          poolIds: loop.pause.poolIds,
          gaps: loop.lastCoverage?.uncoveredRareTerms ?? [],
          rounds: loop.rounds,
          stopReason: loop.stopReason,
        };
      } else if (loop.rounds.length > 0) {
        // The loop ran and finalized within the deterministic budget: the
        // per-round accounting rides the outcome, while an inert loop
        // (zero rounds) adds nothing and stays byte-identical.
        iterativeMarker = {
          phase: "final",
          rounds: loop.rounds,
          stopReason: loop.stopReason,
        };
      }
    }

    if (idsList.length === 0) {
      // Nothing to rank, so this answer owes an explanation: the lanes
      // either named why, or the corpus statement does.
      const corpus = await corpusStatementForEmptyWindow(
        () => effectiveConfig,
        0,
        degraded,
        opts.transportReach,
      );
      const outcome = emptyOutcome({
        store,
        opts,
        query,
        pathPrefix,
        warnings,
        routedSurface,
        degraded,
        corpus,
        ...(iterativeMarker !== null ? { iterative: iterativeMarker } : {}),
      });
      return served(finalize(outcome));
    }

    // Two-tier hydration (recall-quality, C5): the pool hydrates
    // metadata-only - scoring reads ids, paths, hashes and instants,
    // never bodies - and the assembly's content tier pulls bodies for the
    // ranked rows (bounded by the rank cap) before MMR reads them. Peak
    // content memory drops from O(candidates) to O(rankCap).
    const hydrated = store.hydrateChunkRefs(idsList);

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
      hydrateContents: (ids) => {
        const rows = store.hydrateChunks(ids);
        const contents = new Map<number, string>();
        for (const [id, row] of rows) contents.set(id, row.content);
        return contents;
      },
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
      // The arm's eligibility refusals (present only under an active gate
      // mode) ride into the receipt build: under shadow they join the
      // pool's would-be refusals, and under enforce they fill the
      // receipts' enforce section, since the arm drops them before the
      // pool where no exclusion can name them.
      ...(relational.refusals !== undefined ? { armRefusals: relational.refusals } : {}),
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
      results: pinCommittedEvidence(postRank.results, limit, committedEvidenceIds),
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
    const built = buildSearchOutcome({
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
      // The arm's reach-gated paths ride into the outcome builder so
      // the retrieval trail renders them; empty (arm off) projects to
      // no trail entry at all.
      ...(relational.reachByChunk.size > 0 ? { relationalReach: relational.reachByChunk } : {}),
      ...(postRank.decisionModel?.answerable !== undefined
        ? { decisionModel: { answerable: postRank.decisionModel.answerable } }
        : {}),
      // The iterative marker is a property of this request's phase, not
      // of the ranking; the builder projects it verbatim, so every
      // no-marker outcome serializes exactly as before.
      ...(iterativeMarker !== null ? { iterative: iterativeMarker } : {}),
    });
    return served(emit(built));
  } finally {
    await store.close();
  }
}
