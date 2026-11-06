/**
 * The one string order the brain store uses wherever two machines must
 * agree on an order: code unit order, as written, with no locale. Shard
 * paths, record ids and cut entries all sort through it.
 */

/** Negative, zero or positive as `a` sorts before, with or after `b` in code unit order. */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
