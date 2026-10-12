/**
 * Bounded iterative recall loop (recall-quality wave, t_6b943fc7 lane A).
 *
 * The self-correcting second pass rescues a first pass at most once; a
 * hard multi-hop query can still leave rare query terms uncovered after
 * that retry, and nothing ever closed them. This driver generalizes the
 * retry into a bounded N-round loop over the SAME pool-merging
 * discipline: each round re-measures the pool's coverage, emits up to k
 * follow-up sub-query groups (the generalized targeted-retry planner in
 * `../coverage.ts`), pulls each group through the same scoped FTS call
 * the round-two retry uses, and merges only the NEW candidates.
 *
 * The kernel stays deterministic and model-free: every sub-query the
 * deterministic rounds pull is coverage-derived. The caller-executed
 * decider step (the one model round the card asks for) layers on top of
 * these rounds via `../decider-step.ts`: the pause envelope hands the
 * caller the surviving gaps, and the committed payload's sub-queries
 * drive the next round's pulls ({@link runDeciderRound}).
 *
 * Four bounds close the loop, in the order they are checked:
 *   1. the composite hybrid deadline (the caller's clock, already
 *      bounding every other un-budgeted phase);
 *   2. the round cap (`iterativeRecallMaxRounds`);
 *   3. coverage completeness - no measurable gap, no round;
 *   4. the extracted marginal-value stop
 *      (`../../brain/retrieval-plan.ts`): fed per-round candidate yields
 *      and per-round elapsed time instead of the advisor's pack curve,
 *      it retires a round whose yield fell below the same 0.25 floor
 *      fraction (tightening as the loop slows) - adaptation, not
 *      verbatim reuse, of the advisor formula. A round that recovers
 *      nothing stops the loop outright: re-running identical pulls
 *      against an unchanged pool cannot progress.
 *
 * When measurable gaps survive those bounds and the clock still runs,
 * the outcome PAUSES: it carries the caller-executed decider step (the
 * one model round the card asks for, built by `../decider-step.ts`)
 * as a plan-phase envelope plus an opaque single-use round token. A
 * committed payload drives exactly one further round via
 * {@link runDeciderRound} - the decider round is additive to the cap,
 * which bounds the deterministic floor, and it is the call's last
 * gap-driven round; a declined or absent commit finalizes the loop
 * honestly instead of blocking it.
 */

import { planSubQueryGroups, significantTerms, type CoverageReport } from "../coverage.ts";
import { buildDeciderStep, commitDeciderStep, type DeciderPause } from "../decider-step.ts";
// The stop predicate is a pure leaf, so the pipeline reads the exact
// advisor formula without dragging the advisor's dependency graph in.
import { marginalValueStop } from "../../brain/marginal-value-stop.ts";
import type { PropertyPushdown } from "../property-pushdown.ts";
import { poolCoverageForRetry, runSubQueryPull } from "./second-pass.ts";
import type { ValidityWindow } from "../validity.ts";
import type { KeywordHit, Store } from "../store.ts";
import type { ResolvedTimeRange } from "../time-range.ts";
import type {
  IterativeRoundRecord,
  IterativeStopReason,
  ResolvedSearchConfig,
  SearchOptions,
} from "../types.ts";
import {
  ITERATIVE_RECALL_MAX_ROUNDS_CAP,
  ITERATIVE_RECALL_MAX_ROUNDS_DEFAULT,
  SearchError,
} from "../types.ts";

// The knob bounds live on the leaf config module (see its docblock);
// re-exported here so a driver consumer reads one namespace.
export { ITERATIVE_RECALL_MAX_ROUNDS_CAP, ITERATIVE_RECALL_MAX_ROUNDS_DEFAULT } from "../types.ts";
/** Most sub-query groups one round may spend pulls on. */
export const ITERATIVE_SUB_QUERY_GROUPS_PER_ROUND = 2;

// The stop vocabulary and the per-round record live on the leaf config
// module beside the outcome marker they project into; re-exported here so
// a driver consumer reads one namespace.
export type { IterativeRoundRecord, IterativeStopReason } from "../types.ts";

export interface IterativeLoopInput {
  readonly store: Store;
  /** Residual query text (time directives already stripped). */
  readonly query: string;
  readonly limit: number;
  readonly pathPrefix: string | undefined;
  /** Same pushdown the first-pass lanes ran (recall-quality, C4). */
  readonly kind?: "page" | "section";
  readonly pushdown?: PropertyPushdown;
  readonly timeRange: ResolvedTimeRange | null;
  readonly validityWindowFor: (path: string) => ValidityWindow | null;
  readonly keywordHits: KeywordHit[];
  /** The candidate id set; each round adds to it in place. */
  readonly chunkIds: Set<number>;
  /**
   * The caller's reach rule over the loop's working set: withheld
   * candidates never enter the pool, so the round accounting, the
   * coverage gaps and the decider pause envelope are all post-reach -
   * the existence and cardinality oracle FilteredPool.preVisibility
   * exists to close. Absent (local reach): byte-identical.
   */
  readonly filterReachableIds?: (ids: ReadonlyArray<number>) => ReadonlyArray<number>;
  readonly ids: ReadonlyArray<number>;
  readonly maxRounds: number;
  /** Round number the loop's first round takes (2, or 3 after a fired second pass). */
  readonly firstRoundNumber: number;
  /** The composite deadline's expiry, shared with every other phase. */
  readonly isExpired: () => boolean;
  /** The loop's clock; injectable so the stop verdict is testable. */
  readonly nowMs?: () => number;
  /**
   * Plan-phase mint hook, handed to the decider pause when one is built
   * (see {@link buildDeciderStep}): register the pause state under a
   * nonce token and return it, or return null to fall back to the
   * deterministic token. The input carries the executed round count and
   * stop reason beside the digest, so the row is a complete replay brief
   * for the commit leg. Absent on a commit leg's replay - the replay
   * rebuilds the pause only to validate the caller's token against it,
   * and must not file a registry row for a state the caller never
   * received.
   */
  readonly mintRoundToken?: (input: {
    readonly round: number;
    readonly pauseDigest: string;
    readonly deterministicRounds: number;
    readonly stopReason: IterativeStopReason;
  }) => string | null;
  /**
   * Replay brief for the commit leg: the plan's recorded deterministic
   * round count. The loop then runs EXACTLY that many rounds and skips
   * the two wall-clock stop inputs - the composite-deadline checks and
   * the marginal-value verdict (whose latency term is elapsed time) -
   * because a slower replay would otherwise retire rounds the plan ran
   * and arrive at a different pause than the one the caller answered.
   * The deterministic sub-queries are recomputed as usual; only the
   * clock-dependent stops are silenced. Undefined on a plan leg: every
   * stop, the deadline included, is live.
   */
  readonly replayRounds?: number;
}

export interface IterativeLoopOutcome {
  readonly keywordHits: KeywordHit[];
  readonly ids: number[];
  readonly rounds: ReadonlyArray<IterativeRoundRecord>;
  readonly stopReason: IterativeStopReason;
  /**
   * The last coverage measured over the final pool: the gap list a
   * caller-facing plan phase is built from, and `null` when no coverage
   * was ever measured (an expired clock before the first check).
   */
  readonly lastCoverage: CoverageReport | null;
  /**
   * The caller-executed decider step: present exactly when measurable
   * gaps survived the deterministic budget and the clock still runs, so
   * the caller may spend ONE further round by committing a payload. A
   * committed round is additive to the cap - the cap bounds the
   * deterministic floor, the decider round is the card's one additive
   * model round per call - and it is the call's LAST gap-driven round.
   */
  readonly pause: DeciderPause | null;
}

/**
 * Run the bounded loop over the current pool. Mutates `chunkIds` exactly
 * as the round-two retry does; the returned `keywordHits` and `ids`
 * replace the caller's for the rest of the pipeline.
 */
export function runIterativeRecall(input: IterativeLoopInput): IterativeLoopOutcome {
  const now = input.nowMs ?? Date.now;
  const startMs = now();
  // The replay brief (see IterativeLoopInput.replayRounds): a replay
  // runs the recorded count and answers to no clock of its own - the
  // digest check at commit time, not the stopwatch, decides whether it
  // landed where the plan did.
  const replaying = input.replayRounds !== undefined;
  const targetRounds = replaying ? input.replayRounds! : input.maxRounds;
  // The reach rule bounds the pool BEFORE the first coverage measurement:
  // the raw candidate set can carry withheld first-pass candidates, and a
  // withheld candidate covering a rare term would close that term's gap
  // and could flip the loop to coverage_complete over a term the caller
  // can never see a candidate for. The per-round keepReachable filtering
  // below stays - defense in depth at every later addition.
  if (input.filterReachableIds) {
    const reachable = new Set(input.filterReachableIds(Array.from(input.chunkIds)));
    for (const id of Array.from(input.chunkIds)) {
      if (!reachable.has(id)) input.chunkIds.delete(id);
    }
  }
  const rounds: IterativeRoundRecord[] = [];
  const yields: number[] = [];
  const costsMs: number[] = [];
  let keywordHits = input.keywordHits;
  let stop: IterativeStopReason | null = null;
  let lastCoverage: CoverageReport | null = null;

  while (rounds.length < targetRounds) {
    if (!replaying && input.isExpired()) {
      stop = "deadline";
      break;
    }
    const coverage = poolCoverageForRetry({
      store: input.store,
      query: input.query,
      ids: Array.from(input.chunkIds),
      timeRange: input.timeRange,
      validityWindowFor: input.validityWindowFor,
    });
    lastCoverage = coverage;
    const plan = planSubQueryGroups(coverage, ITERATIVE_SUB_QUERY_GROUPS_PER_ROUND);
    if (!plan.fire) {
      // The gap signal has nothing to fire at. Where the measurement
      // exists, the completeness threshold is the verdict the whole
      // coverage engine agrees on, so the pool is complete by
      // definition; only an unmeasurable coverage (no IDF mass to take
      // a share of) is a different state, named as its own.
      stop =
        coverage.idfWeightedCoverage === null || coverage.terms.length === 0
          ? "no_sub_query"
          : "coverage_complete";
      break;
    }
    // The marginal-value stop is retrospective: it certifies the rounds
    // already run, so the loop discovers a round was not worth it by
    // doing it - the cap bounds the discovery cost, the same trade the
    // advisor makes when it cuts a curve it has already priced. Its
    // latency term is wall-clock elapsed, so a replay (which must arrive
    // at the plan's pause, not at its own watch's verdict) skips it.
    if (rounds.length > 0 && !replaying) {
      const verdict = marginalValueStop(yields, costsMs, now() - startMs);
      if (verdict.stopRank < rounds.length) {
        stop = "marginal_value";
        break;
      }
    }
    const roundStartMs = now();
    const roundNumber = input.firstRoundNumber + rounds.length;
    const terms: string[] = [];
    const recovered: KeywordHit[] = [];
    for (const group of plan.groups) {
      terms.push(...group.terms);
      const pull = runSubQueryPull(input.store, group.terms, {
        limit: input.limit,
        pathPrefix: input.pathPrefix,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.pushdown !== undefined ? { pushdown: input.pushdown } : {}),
      });
      for (const hit of pull.hits) {
        if (input.chunkIds.has(hit.chunkId)) continue;
        input.chunkIds.add(hit.chunkId);
        recovered.push(hit);
      }
    }
    // The reach rule decides what a round "recovered": at non-local reach
    // a withheld candidate never enters the pool, the round accounting or
    // the trail, so the counts a remote caller reads are counts of
    // candidates it could actually be shown.
    if (input.filterReachableIds) {
      const survivors = keepReachable(recovered, input.filterReachableIds, input.chunkIds);
      recovered.length = 0;
      recovered.push(...survivors);
    }
    keywordHits = keywordHits.concat(...recovered);
    const added = recovered.length;
    rounds.push(
      Object.freeze({
        round: roundNumber,
        terms: Object.freeze(terms),
        groups: plan.groups.length,
        added,
        elapsedMs: now() - roundStartMs,
        author: "deterministic" as const,
      }),
    );
    yields.push(added);
    costsMs.push(now() - roundStartMs);
    if (added === 0) {
      // The pool did not move: the next round would propose the same
      // groups against the same coverage and recover the same nothing.
      stop = "no_progress";
      break;
    }
  }

  if (stop === null) stop = "round_cap";
  // The loop's last measurement was taken at the TOP of the final round -
  // before that round's pulls landed. Every decision about the FINAL pool
  // (the reported coverage, and whether gaps survived for a decider
  // round) reads a measurement over the pool AS IT IS NOW, so a budget
  // that just closed its gaps finalizes instead of pausing on stale
  // gaps. Zero-round loops already hold the final pool's measurement; an
  // expired clock keeps the last one it took; a replay re-measures
  // whatever its own clock is doing, because the state it must reach is
  // the plan's, not its watch's.
  if (rounds.length > 0 && (replaying || (stop !== "deadline" && !input.isExpired()))) {
    lastCoverage = poolCoverageForRetry({
      store: input.store,
      query: input.query,
      ids: Array.from(input.chunkIds),
      timeRange: input.timeRange,
      validityWindowFor: input.validityWindowFor,
    });
  }
  // The decider pause: measurable gaps survived the deterministic budget,
  // the clock still runs, and the pool has candidates to select evidence
  // from. Any other exit - coverage complete, nothing measurable to fire
  // at, an expired clock - finalizes without asking the caller for a
  // model round. buildDeciderStep re-checks the same fire gate the block
  // above reads, so the two can never drift apart silently. A replay is
  // clock-blind here too: its state is the plan's by construction, and
  // the plan already decided the clock was alive when it minted.
  let pause: DeciderPause | null = null;
  const reachablePoolIds = input.filterReachableIds
    ? input.filterReachableIds(Array.from(input.chunkIds))
    : Array.from(input.chunkIds);
  if (
    stop !== "coverage_complete" &&
    stop !== "no_sub_query" &&
    stop !== "deadline" &&
    (replaying || !input.isExpired()) &&
    lastCoverage !== null &&
    input.chunkIds.size > 0 &&
    reachablePoolIds.length > 0 &&
    planSubQueryGroups(lastCoverage, 1).fire
  ) {
    pause = buildDeciderStep({
      query: input.query,
      round: input.firstRoundNumber + rounds.length,
      coverage: lastCoverage,
      poolIds: reachablePoolIds,
      ...(input.mintRoundToken !== undefined
        ? {
            mintRoundToken: (mint) =>
              input.mintRoundToken?.({
                round: input.firstRoundNumber + rounds.length,
                pauseDigest: mint.pauseDigest,
                deterministicRounds: rounds.length,
                stopReason: stop!,
              }) ?? null,
          }
        : {}),
    });
  }
  return Object.freeze({
    keywordHits,
    ids: Array.from(input.chunkIds),
    rounds: Object.freeze(rounds),
    stopReason: stop,
    lastCoverage: lastCoverage === null ? null : lastCoverage,
    pause,
  });
}

export interface DeciderRoundInput {
  readonly store: Store;
  readonly query: string;
  readonly limit: number;
  readonly pathPrefix: string | undefined;
  readonly kind?: "page" | "section";
  readonly pushdown?: PropertyPushdown;
  readonly timeRange: ResolvedTimeRange | null;
  readonly validityWindowFor: (path: string) => ValidityWindow | null;
  /** The pause the plan phase emitted. */
  readonly pause: DeciderPause;
  /** The caller's round token and payload, validated before any pull. */
  readonly token: string;
  readonly payload: unknown;
  /** Round tokens already spent, including across resumed calls. */
  readonly usedTokens: ReadonlySet<string>;
  /**
   * The pause digest the registry stored for the submitted token, read by
   * the caller from the token's mint row (see
   * {@link DeciderCommitScope.mintedPauseDigest}). Undefined when no row
   * stands behind the token.
   */
  readonly mintedPauseDigest?: string;
  readonly keywordHits: KeywordHit[];
  /** The candidate id set; the round adds to it in place. */
  readonly chunkIds: Set<number>;
  /** Same rule as the driver's {@link IterativeLoopInput.filterReachableIds}. */
  readonly filterReachableIds?: (ids: ReadonlyArray<number>) => ReadonlyArray<number>;
  readonly priorRounds: ReadonlyArray<IterativeRoundRecord>;
  /** The loop's clock; injectable so the round record is testable. */
  readonly nowMs?: () => number;
}

export interface DeciderRoundOutcome {
  readonly keywordHits: KeywordHit[];
  readonly ids: number[];
  /** The committed round's own record (author "decider"). */
  readonly round: IterativeRoundRecord;
  /** Every round of the call: the deterministic rounds plus this one. */
  readonly rounds: ReadonlyArray<IterativeRoundRecord>;
  readonly stopReason: IterativeStopReason;
  /**
   * The pool-validated evidence ids the commit pinned: carried out so the
   * caller's selection can reach the final ranking instead of being
   * validated and discarded.
   */
  readonly evidenceIds: ReadonlyArray<number>;
  /** The spent token, echoed so the caller records its single use. */
  readonly token: string;
}

/**
 * Execute the committed decider round: validate the payload (shape,
 * registered semantic rules, token single use, evidence in the pool) and
 * run exactly the pulls its sub-queries name, merging only new
 * candidates into the pool. The pool grows by nothing else - no
 * coverage re-proposal runs here; the caller's sub-queries ARE the
 * round. A refused payload throws before any pull, so a bad commit
 * never advances the loop.
 */
/**
 * Keep only the hits whose chunk the reach rule shows the caller, and
 * evict the rest from the pool set they were already added to.
 */
function keepReachable(
  recovered: KeywordHit[],
  filterReachableIds: (ids: ReadonlyArray<number>) => ReadonlyArray<number>,
  chunkIds: Set<number>,
): KeywordHit[] {
  const survivors = new Set(filterReachableIds(recovered.map((hit) => hit.chunkId)));
  for (const hit of recovered) {
    if (!survivors.has(hit.chunkId)) chunkIds.delete(hit.chunkId);
  }
  return recovered.filter((hit) => survivors.has(hit.chunkId));
}

export function runDeciderRound(input: DeciderRoundInput): DeciderRoundOutcome {
  const now = input.nowMs ?? Date.now;
  const commit = commitDeciderStep(input.token, input.payload, {
    query: input.query,
    round: input.pause.round,
    poolIds: input.pause.poolIds,
    usedTokens: input.usedTokens,
    ...(input.mintedPauseDigest !== undefined
      ? { mintedPauseDigest: input.mintedPauseDigest }
      : {}),
  });
  const roundStartMs = now();
  const recovered: KeywordHit[] = [];
  for (const subQuery of commit.subQueries) {
    const pull = runSubQueryPull(input.store, significantTerms(subQuery), {
      limit: input.limit,
      pathPrefix: input.pathPrefix,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.pushdown !== undefined ? { pushdown: input.pushdown } : {}),
    });
    for (const hit of pull.hits) {
      if (input.chunkIds.has(hit.chunkId)) continue;
      input.chunkIds.add(hit.chunkId);
      recovered.push(hit);
    }
  }
  if (input.filterReachableIds) {
    const survivors = keepReachable(recovered, input.filterReachableIds, input.chunkIds);
    recovered.length = 0;
    recovered.push(...survivors);
  }
  const round: IterativeRoundRecord = Object.freeze({
    round: input.pause.round,
    terms: Object.freeze([] as string[]),
    groups: 0,
    added: recovered.length,
    elapsedMs: now() - roundStartMs,
    author: "decider" as const,
    subQueries: commit.subQueries,
  });
  return Object.freeze({
    keywordHits: input.keywordHits.concat(...recovered),
    ids: Array.from(input.chunkIds),
    round,
    rounds: Object.freeze([...input.priorRounds, round]),
    stopReason: "decider_round" as const,
    evidenceIds: commit.evidenceIds,
    token: commit.token,
  });
}

/**
 * The operator's resolved round cap: the configured value or the default,
 * clamped to the cap. The one resolution every consumer shares -
 * `resolveIterativeRequest` runs the loop under it, and the plan-leg cache
 * key suffix names it (`itv:plan:r<N>`), so raising the cap re-keys cached
 * plans instead of serving one recorded under the old round count.
 */
export function resolveIterativeMaxRounds(config: ResolvedSearchConfig): number {
  const maxRounds = config.recall.iterativeRecallMaxRounds ?? ITERATIVE_RECALL_MAX_ROUNDS_DEFAULT;
  return Math.min(maxRounds, ITERATIVE_RECALL_MAX_ROUNDS_CAP);
}

/**
 * Which leg of the round-trip this request is: the flag alone asks for
 * the plan phase (deterministic rounds, then pause with an envelope when
 * gaps survive); the token plus payload asks for the commit phase
 * (validate, then run the committed round).
 */
export type IterativePhase = "plan" | "commit";

/**
 * Resolve the caller's iterative request fields. The request flag is the
 * per-query opt-in; the resolved knob is the operator's master switch, so
 * a flag without the knob is inert (byte-identical), not an error. Any
 * stray iterative-only field without the flag is a named refusal rather
 * than a silently ignored argument, and so is a half-specified commit
 * (a token without its payload, a payload without a token, or a
 * blank token) - a request the caller thinks is one thing but the
 * kernel would execute as another is exactly the silent fallback this
 * pipeline refuses to guess at.
 */
export function resolveIterativeRequest(
  opts: Pick<SearchOptions, "iterative" | "iterativeToken" | "iterativePayload">,
  config: ResolvedSearchConfig,
): { readonly maxRounds: number; readonly phase: IterativePhase } | null {
  const tokenGiven = opts.iterativeToken !== undefined;
  const payloadGiven = opts.iterativePayload !== undefined;
  if (opts.iterative !== true) {
    if (tokenGiven || payloadGiven) {
      throw new SearchError(
        "INVALID_INPUT",
        "iterativeToken/iterativePayload require iterative: true; a commit without the flag is refused rather than ignored",
      );
    }
    return null;
  }
  if (tokenGiven !== payloadGiven) {
    throw new SearchError(
      "INVALID_INPUT",
      tokenGiven
        ? "iterativeToken requires iterativePayload: a commit is token plus payload"
        : "iterativePayload requires iterativeToken: a commit is token plus payload",
    );
  }
  if (tokenGiven && (typeof opts.iterativeToken !== "string" || opts.iterativeToken.length === 0)) {
    throw new SearchError("INVALID_INPUT", "iterativeToken must be a non-empty string");
  }
  if (config.recall.iterativeRecallEnabled !== true) {
    // The knob alone being inert is the designed master-switch: a flagged
    // plan call runs nothing. A fully-formed commit is different - every
    // field of a commit is present, so silently running it as a plain
    // search would drop its marker and spend nothing it named; it is
    // refused by name instead, so the caller learns the loop is off
    // rather than reading a plain answer as its commit's outcome.
    if (tokenGiven) {
      throw new SearchError(
        "INVALID_INPUT",
        "iterative commit refused: the iterative recall loop is disabled by operator config",
      );
    }
    return null;
  }
  const maxRounds = resolveIterativeMaxRounds(config);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new SearchError(
      "INVALID_INPUT",
      `iterativeRecallMaxRounds must be an integer >= 1, got ${String(maxRounds)}`,
    );
  }
  return {
    maxRounds,
    phase: tokenGiven ? "commit" : "plan",
  };
}
