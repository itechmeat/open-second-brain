/**
 * The shared exactly-one decision.
 *
 * Two features bind a candidate to a target only when exactly one
 * candidate carries it - the repair lane binding a mention term to a
 * corpus page, pre-extract binding a relative import specifier to an
 * ingested file. Both must answer "zero" and "more than one" the same
 * conservative way, so the decision lives here instead of in two call
 * sites that can drift. The domains stay local to their callers: this
 * module decides, it does not know what a candidate is.
 *
 * Every status a caller can receive is part of the type, so a caller
 * cannot forget the ambiguous case: dropping it is a compile error, not
 * a silent loss.
 */

/**
 * The outcome of an exactly-one decision: the single target, every
 * distinct candidate in first-occurrence order, or nothing.
 */
export type UniqueMatch<T> =
  | { readonly status: "none" }
  | { readonly status: "unique"; readonly target: T }
  | { readonly status: "ambiguous"; readonly matches: ReadonlyArray<T> };

/**
 * Decide `candidates` under the exactly-one rule. A candidate repeated in
 * the input is one candidate: one page naming a term twice must never
 * read as two pages naming it. The ambiguous list keeps first-occurrence
 * order, so the same input always reports the same list.
 */
export function resolveUniqueMatch<T>(candidates: ReadonlyArray<T>): UniqueMatch<T> {
  const distinct: T[] = [];
  const seen = new Set<T>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    distinct.push(candidate);
  }
  if (distinct.length === 0) return { status: "none" };
  if (distinct.length === 1) return { status: "unique", target: distinct[0]! };
  return { status: "ambiguous", matches: distinct };
}
