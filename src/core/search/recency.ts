/**
 * Pure Weibull recency decay (v0.20.0).
 *
 * Replaces the prior hardcoded step function (<=7d -> 0.05, <=30d ->
 * 0.025, <=90d -> 0.01, else 0) with a continuous, configurable curve so
 * a vault can tune how fast older content loses its recency boost.
 *
 * The boost is the Weibull survival function scaled by an amplitude:
 *
 *   boost(age) = amplitude * exp( -(age / scale)^shape )
 *
 * At age 0 the survival term is 1, so the boost equals `amplitude` (the
 * maximum). As age grows the boost decays monotonically toward 0. `shape`
 * controls the curvature (k); `scale` is the characteristic lifetime in
 * days (lambda). The defaults approximate the old step function while
 * smoothing the cliffs at the 7/30/90-day boundaries.
 *
 * The function is pure and deterministic: no Date.now(), no Math.random().
 * Callers pass an already-computed age in days, so the time source stays
 * injectable at the ranker boundary.
 */

export interface WeibullRecencyOptions {
  /** Weibull shape parameter k (> 0). Lower values decay faster early. */
  readonly shape: number;
  /** Weibull scale parameter lambda in days (> 0): the characteristic lifetime. */
  readonly scale: number;
  /** Maximum boost at age 0, clamped into [0, 1]. */
  readonly amplitude: number;
}

/**
 * Default curve. Approximates the legacy step function: ~0.043 at 3 days,
 * ~0.024 at 20 days, ~0.009 at 60 days, and decays below the display
 * epsilon by roughly half a year.
 */
export const DEFAULT_RECENCY: WeibullRecencyOptions = Object.freeze({
  shape: 0.8,
  scale: 30,
  amplitude: 0.05,
});

/**
 * Below this the boost rounds to 0.000 at the 3-decimal precision the
 * explainable-recall `reasons` use, so we floor it to exactly 0. This
 * keeps an effectively-stale page from carrying a noise-level recency
 * layer and preserves the "old content has no recency reason" contract.
 */
const EPSILON = 0.0005;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Recency boost for a content age in days under a Weibull curve. Ages at
 * or below 0 (including future timestamps) yield the full amplitude.
 * Non-positive shape/scale/amplitude disable the boost (returns 0), the
 * documented off switch. Results below the display epsilon floor to 0.
 */
export function weibullDecay(ageDays: number, opts: WeibullRecencyOptions): number {
  const amplitude = clamp01(opts.amplitude);
  if (amplitude === 0 || !(opts.shape > 0) || !(opts.scale > 0)) return 0;
  if (!Number.isFinite(ageDays) || ageDays <= 0) return amplitude;

  const survival = Math.exp(-Math.pow(ageDays / opts.scale, opts.shape));
  const boost = amplitude * survival;
  return boost < EPSILON ? 0 : boost;
}
