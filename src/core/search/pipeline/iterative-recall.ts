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
 * The kernel stays deterministic and model-free: every sub-query here is
 * coverage-derived. The caller-executed decider step (the one model
 * round the card asks for) is layered on top by `../../search/
 * decider-step.ts` and consumes this module's rounds and stop verdict.
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
 */

import { planSubQueryGroups, type CoverageReport } from "../coverage.ts";
import { marginalValueStop } from "../../brain/retrieval-plan.ts";
import type { PropertyPushdown } from "../property-pushdown.ts";
import { poolCoverageForRetry, runSubQueryPull } from "./second-pass.ts";
import type { ValidityWindow } from "../validity.ts";
import type { KeywordHit, Store } from "../store.ts";
import type { ResolvedTimeRange } from "../time-range.ts";
import type { ResolvedSearchConfig, SearchOptions } from "../types.ts";
import { SearchError } from "../types.ts";

/** Gap-driven rounds the loop may run when the config names no cap. */
export const ITERATIVE_RECALL_MAX_ROUNDS_DEFAULT = 2;
/** Hard ceiling the config resolver clamps the round cap to. */
export const ITERATIVE_RECALL_MAX_ROUNDS_CAP = 8;
/** Most sub-query groups one round may spend pulls on. */
export const ITERATIVE_SUB_QUERY_GROUPS_PER_ROUND = 2;

/** Why the loop stopped; recorded on the outcome's per-round observability. */
export type IterativeStopReason =
  | "coverage_complete"
  | "no_sub_query"
  | "no_progress"
  | "round_cap"
  | "marginal_value"
  | "deadline";

/** One executed round: what it pulled, what it recovered, what it cost. */
export interface IterativeRoundRecord {
  /** 1-based round number; 1 is the initial lanes, so rounds start at 2. */
  readonly round: number;
  readonly terms: ReadonlyArray<string>;
  readonly groups: number;
  readonly added: number;
  readonly elapsedMs: number;
  /** Who authored the sub-queries: the deterministic floor, or the decider. */
  readonly author: "deterministic" | "decider";
}

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
  readonly ids: ReadonlyArray<number>;
  readonly maxRounds: number;
  /** Round number the loop's first round takes (2, or 3 after a fired second pass). */
  readonly firstRoundNumber: number;
  /** The composite deadline's expiry, shared with every other phase. */
  readonly isExpired: () => boolean;
  /** The loop's clock; injectable so the stop verdict is testable. */
  readonly nowMs?: () => number;
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
}

/**
 * Run the bounded loop over the current pool. Mutates `chunkIds` exactly
 * as the round-two retry does; the returned `keywordHits` and `ids`
 * replace the caller's for the rest of the pipeline.
 */
export function runIterativeRecall(input: IterativeLoopInput): IterativeLoopOutcome {
  const now = input.nowMs ?? Date.now;
  const startMs = now();
  const rounds: IterativeRoundRecord[] = [];
  const yields: number[] = [];
  const costsMs: number[] = [];
  let keywordHits = input.keywordHits;
  let stop: IterativeStopReason | null = null;
  let lastCoverage: CoverageReport | null = null;

  while (rounds.length < input.maxRounds) {
    if (input.isExpired()) {
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
    // advisor makes when it cuts a curve it has already priced.
    if (rounds.length > 0) {
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
  return Object.freeze({
    keywordHits,
    ids: Array.from(input.chunkIds),
    rounds: Object.freeze(rounds),
    stopReason: stop,
    lastCoverage: lastCoverage === null ? null : lastCoverage,
  });
}

/**
 * Resolve the caller's iterative request fields. The request flag is the
 * per-query opt-in; the resolved knob is the operator's master switch, so
 * a flag without the knob is inert (byte-identical), not an error. Any
 * stray iterative-only field without the flag is a named refusal rather
 * than a silently ignored argument.
 */
export function resolveIterativeRequest(
  opts: Pick<SearchOptions, "iterative">,
  config: ResolvedSearchConfig,
): { readonly maxRounds: number } | null {
  if (opts.iterative !== true) return null;
  if (config.recall.iterativeRecallEnabled !== true) return null;
  const maxRounds = config.recall.iterativeRecallMaxRounds ?? ITERATIVE_RECALL_MAX_ROUNDS_DEFAULT;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new SearchError(
      "INVALID_INPUT",
      `iterativeRecallMaxRounds must be an integer >= 1, got ${String(maxRounds)}`,
    );
  }
  return { maxRounds: Math.min(maxRounds, ITERATIVE_RECALL_MAX_ROUNDS_CAP) };
}
