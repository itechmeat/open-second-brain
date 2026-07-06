/**
 * Numeric primitives shared across scoring/ranking code (search relevance,
 * recency decay, brain query-demand). No I/O, no side effects.
 */

/** Clamp `x` to `[0, 1]`. Non-finite input (`NaN`, `Infinity`) clamps to `0`. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
