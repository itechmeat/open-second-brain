/**
 * Materialize-freshness gate (Ingestion & Import Robustness suite,
 * t_845fe240; three-state verdict from evidence-at-the-boundary, unit
 * B4).
 *
 * A deterministic refresh that materializes outputs from inputs (e.g. the
 * clusters pass writes `Brain/clusters/` from the vault's notes) can be a
 * no-op when the outputs are already newer than every input. This
 * primitive answers that question so an agent can invoke the refresh
 * cheaply at the start of graph work - the expensive recompute runs only
 * when it might produce something different.
 *
 * ## Why the boolean had to go
 *
 * The original answer was `fresh: boolean`, computed as
 * `min(outputs.mtime) >= max(inputs.mtime)` and nothing else. Two
 * defects followed from the shape rather than from the arithmetic:
 *
 *   - It was purely content-relative, with no wall clock anywhere in the
 *     module. An output materialized in 2019 from inputs untouched since
 *     was fresh forever, so `--if-stale` on such a vault could never do
 *     the work - not "did the work and found nothing", but never looked.
 *   - A measurement that did not happen had to be reported as one of the
 *     two real answers. Inputs LISTED but not stat-able reported `true`,
 *     which is "outputs are up to date, skip the recompute"; outputs
 *     listed but not stat-able reported `false`, indistinguishable from
 *     "nothing has been materialized yet".
 *
 * So the verdict is now three-valued, and `unknown` carries the reason
 * it could not decide. None of the three is a softer way of saying the
 * others: `fresh` is a claim that the recompute would change nothing,
 * `stale` is a claim that it might, and `unknown` is the refusal to make
 * either claim. The boolean was dropped rather than kept as a shim -
 * there is exactly one caller, and a boolean cannot carry `unknown`.
 *
 * ## Any unreadable member, not every unreadable member
 *
 * A single listed path that will not stat makes the whole verdict
 * `unknown`. The rejected alternative is the one that shipped: ignore
 * unreadable members and compare the rest, on the argument that "a
 * transient stat failure never forces a needless recompute". That
 * argument only holds if you accept a wrong `fresh`, because the input
 * that would not stat may be the newest one in the vault and the output
 * that would not stat may be the oldest one on disk - precisely the two
 * values the comparison is built from. The cost of the strict rule is a
 * recompute the caller was going to be able to do anyway; the cost of
 * the lax one is a skipped recompute justified by a measurement that
 * never happened.
 *
 * An EMPTY list is not a failed measurement: it is an answer, and the
 * caller who produced the list is the only one who can tell the two
 * apart. No inputs at all therefore stays `fresh` - there is nothing
 * that could have changed.
 *
 * ## The ceiling is resolved, never defaulted here
 *
 * `maxAgeMs` is optional and has no in-module default. The ceiling is a
 * policy question (`health.materialize_max_age_days`), and a default
 * baked in here would be a second, invisible answer to it that no
 * operator could see in their config. Omitting it reproduces the
 * pre-ceiling comparison exactly.
 *
 * Language-agnostic: only filesystem mtimes are compared; no content is
 * read.
 */

import { statSync } from "node:fs";

/** The three answers a materialize-freshness read can honestly give. */
export const MATERIALIZE_FRESHNESS = Object.freeze({
  /** Every output was measured, is newer than every input, and is inside the ceiling. */
  fresh: "fresh",
  /** The recompute might produce something different; `staleReason` says why. */
  stale: "stale",
  /** No verdict could be reached; `unknownReason` says what could not be measured. */
  unknown: "unknown",
} as const);

/** Closed union over {@link MATERIALIZE_FRESHNESS}. */
export type MaterializeFreshness =
  (typeof MATERIALIZE_FRESHNESS)[keyof typeof MATERIALIZE_FRESHNESS];

/** Membership list, ordered from the strongest claim to no claim at all. */
export const MATERIALIZE_FRESHNESS_STATES: ReadonlyArray<MaterializeFreshness> = Object.freeze([
  MATERIALIZE_FRESHNESS.fresh,
  MATERIALIZE_FRESHNESS.stale,
  MATERIALIZE_FRESHNESS.unknown,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isMaterializeFreshness(value: unknown): value is MaterializeFreshness {
  return (
    typeof value === "string" &&
    (MATERIALIZE_FRESHNESS_STATES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Why a recompute might produce something different. Each member is a
 * fact about this vault's files, never a guess about intent.
 */
export const MATERIALIZE_STALE_REASON = Object.freeze({
  /** No outputs were listed at all: nothing has been materialized yet. */
  notMaterialized: "not_materialized",
  /** An input's mtime is newer than the oldest output's. */
  inputNewer: "input_newer",
  /**
   * Every input is older than every output, but the oldest output is
   * older by wall clock than the caller's ceiling. This is the reason
   * that did not exist before B4, and its absence is what made an
   * output materialized once fresh for the rest of the vault's life.
   */
  ceilingExceeded: "ceiling_exceeded",
} as const);

/** Closed union over {@link MATERIALIZE_STALE_REASON}. */
export type MaterializeStaleReason =
  (typeof MATERIALIZE_STALE_REASON)[keyof typeof MATERIALIZE_STALE_REASON];

/** Membership list, in the order {@link evaluateStaleness} tests them. */
export const MATERIALIZE_STALE_REASONS: ReadonlyArray<MaterializeStaleReason> = Object.freeze([
  MATERIALIZE_STALE_REASON.notMaterialized,
  MATERIALIZE_STALE_REASON.inputNewer,
  MATERIALIZE_STALE_REASON.ceilingExceeded,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isMaterializeStaleReason(value: unknown): value is MaterializeStaleReason {
  return (
    typeof value === "string" &&
    (MATERIALIZE_STALE_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * What could not be measured. Neither member is a softer way of saying
 * `fresh` or `stale`: both mean the comparison the verdict rests on was
 * never actually performed.
 */
export const MATERIALIZE_UNKNOWN_REASON = Object.freeze({
  /**
   * At least one listed output would not stat. Reported ahead of an
   * unreadable input because it is the side that decides whether
   * anything usable was materialized at all.
   */
  outputsUnreadable: "outputs_unreadable",
  /** At least one listed input would not stat, so "newest input" is not known. */
  inputsUnreadable: "inputs_unreadable",
} as const);

/** Closed union over {@link MATERIALIZE_UNKNOWN_REASON}. */
export type MaterializeUnknownReason =
  (typeof MATERIALIZE_UNKNOWN_REASON)[keyof typeof MATERIALIZE_UNKNOWN_REASON];

/** Membership list, in the order {@link evaluateStaleness} tests them. */
export const MATERIALIZE_UNKNOWN_REASONS: ReadonlyArray<MaterializeUnknownReason> = Object.freeze([
  MATERIALIZE_UNKNOWN_REASON.outputsUnreadable,
  MATERIALIZE_UNKNOWN_REASON.inputsUnreadable,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isMaterializeUnknownReason(value: unknown): value is MaterializeUnknownReason {
  return (
    typeof value === "string" &&
    (MATERIALIZE_UNKNOWN_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/** The instants every verdict reports, whatever the verdict is. */
export interface StalenessMeasurement {
  /** Newest input mtime in ms, or null when no input had a readable mtime. */
  readonly newestInputMs: number | null;
  /** Oldest output mtime in ms, or null when no output existed or read. */
  readonly oldestOutputMs: number | null;
  /** Wall-clock age of the oldest output against `nowMs`, or null when unmeasured. */
  readonly oldestOutputAgeMs: number | null;
}

export interface FreshStalenessResult extends StalenessMeasurement {
  readonly state: typeof MATERIALIZE_FRESHNESS.fresh;
}

export interface StaleStalenessResult extends StalenessMeasurement {
  readonly state: typeof MATERIALIZE_FRESHNESS.stale;
  readonly staleReason: MaterializeStaleReason;
}

export interface UnknownStalenessResult extends StalenessMeasurement {
  readonly state: typeof MATERIALIZE_FRESHNESS.unknown;
  readonly unknownReason: MaterializeUnknownReason;
}

/**
 * A discriminated union rather than one struct with two nullable reason
 * fields: the two reason vocabularies are disjoint, and a flat struct
 * would let `state: "fresh"` be constructed alongside a stale reason.
 */
export type StalenessResult = FreshStalenessResult | StaleStalenessResult | UnknownStalenessResult;

export interface EvaluateStalenessOptions {
  /** Wall clock for the ceiling. Defaults to `Date.now()`. */
  readonly nowMs?: number;
  /**
   * Wall-clock ceiling on the oldest output's age. Absent means no
   * ceiling is applied at all; see the module docblock for why there is
   * no default here.
   */
  readonly maxAgeMs?: number;
}

/** File mtime in ms, or null when the path is missing or unreadable. */
export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The reason behind a verdict, flattened for a log line or a metric
 * payload. `null` for `fresh`, which has no reason: it is the verdict
 * that claims the comparison ran and found nothing to do.
 *
 * Exported so the single caller does not re-derive the pairing of state
 * to reason field, which is the sort of duplication that drifts the
 * moment a fourth state exists.
 */
export function stalenessReason(
  result: StalenessResult,
): MaterializeStaleReason | MaterializeUnknownReason | null {
  if (result.state === MATERIALIZE_FRESHNESS.stale) return result.staleReason;
  if (result.state === MATERIALIZE_FRESHNESS.unknown) return result.unknownReason;
  return null;
}

/**
 * Evaluate whether materialized `outputs` are fresh with respect to
 * `inputs` and to the wall clock.
 *
 * Reported in this order, and the order is the point - the earlier a
 * reason appears, the more it tells an operator:
 *
 *   1. nothing materialized at all;
 *   2. a listed output or input that would not stat (`unknown`);
 *   3. an input newer than the oldest output;
 *   4. the oldest output older than `maxAgeMs`.
 *
 * An age exactly equal to `maxAgeMs` has not exceeded it.
 */
export function evaluateStaleness(
  inputs: readonly string[],
  outputs: readonly string[],
  options: EvaluateStalenessOptions = {},
): StalenessResult {
  const nowMs = options.nowMs ?? Date.now();
  const readableInputs = inputs.map(mtimeMs).filter((m): m is number => m !== null);
  const readableOutputs = outputs.map(mtimeMs).filter((m): m is number => m !== null);

  const newestInputMs = readableInputs.length > 0 ? Math.max(...readableInputs) : null;
  const oldestOutputMs = readableOutputs.length > 0 ? Math.min(...readableOutputs) : null;
  const measured: StalenessMeasurement = {
    newestInputMs,
    oldestOutputMs,
    oldestOutputAgeMs: oldestOutputMs === null ? null : nowMs - oldestOutputMs,
  };

  if (outputs.length === 0) {
    return Object.freeze({
      ...measured,
      state: MATERIALIZE_FRESHNESS.stale,
      staleReason: MATERIALIZE_STALE_REASON.notMaterialized,
    });
  }
  // The `oldestOutputMs === null` clause is subsumed by the count
  // comparison at runtime (a non-empty, fully readable output list
  // always has a minimum); it is written out so the narrowing below is
  // the type checker's conclusion rather than a non-null assertion.
  if (oldestOutputMs === null || readableOutputs.length !== outputs.length) {
    return Object.freeze({
      ...measured,
      state: MATERIALIZE_FRESHNESS.unknown,
      unknownReason: MATERIALIZE_UNKNOWN_REASON.outputsUnreadable,
    });
  }
  if (readableInputs.length !== inputs.length) {
    return Object.freeze({
      ...measured,
      state: MATERIALIZE_FRESHNESS.unknown,
      unknownReason: MATERIALIZE_UNKNOWN_REASON.inputsUnreadable,
    });
  }
  if (newestInputMs !== null && oldestOutputMs < newestInputMs) {
    return Object.freeze({
      ...measured,
      state: MATERIALIZE_FRESHNESS.stale,
      staleReason: MATERIALIZE_STALE_REASON.inputNewer,
    });
  }
  if (options.maxAgeMs !== undefined && nowMs - oldestOutputMs > options.maxAgeMs) {
    return Object.freeze({
      ...measured,
      state: MATERIALIZE_FRESHNESS.stale,
      staleReason: MATERIALIZE_STALE_REASON.ceilingExceeded,
    });
  }
  return Object.freeze({ ...measured, state: MATERIALIZE_FRESHNESS.fresh });
}
