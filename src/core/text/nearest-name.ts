/**
 * Nearest-name suggestion over a known vocabulary
 * (evidence-at-the-boundary, task C3).
 *
 * Nothing in this repository measured string distance before this
 * module: `core/brain/similarity.ts` is word-set Jaccard, which scores
 * `quiery` against `query` at zero because they share no whole word, and
 * `cli/argparse.ts` rejected an unknown flag with no suggestion at all.
 * So a caller who mistyped an argument name got either silence or a
 * refusal that named the mistake without naming the fix.
 *
 * Two decisions worth stating.
 *
 * It is pure string distance over the caller's own vocabulary, never a
 * curated synonym table. A table would encode one language's habits, go
 * stale the moment a parameter is renamed, and quietly stop covering the
 * typo it was written for. The candidate list is always the schema's own
 * property names, so the suggestion cannot name something that does not
 * exist.
 *
 * The distance counts an adjacent transposition as ONE edit (restricted
 * Damerau, also called optimal string alignment) rather than the two
 * plain Levenshtein charges it. Swapped adjacent characters are the
 * commonest typo there is, and at two edits `qeury` falls outside the
 * suggestion threshold for a five-character name - the gate would refuse
 * the call while withholding the one word that fixes it.
 *
 * Pure and side-effect free: no I/O, no clock, no configuration.
 */

/**
 * How far a candidate may sit from the target and still be offered, as a
 * fraction of the longer of the two names.
 *
 * One third: a six-character name tolerates two edits, a five-character
 * name one, and a two-character name none - at that length a single edit
 * is most of the word, and every short name is one edit from every other,
 * so any suggestion would be a coin toss dressed as help.
 */
export const NEAREST_NAME_MAX_DISTANCE_RATIO = 1 / 3;

/**
 * Edit distance between two names: insertions, deletions, substitutions
 * and adjacent transpositions, each costing one.
 *
 * Two rolling rows plus the one before them, so memory is proportional to
 * the shorter name rather than to the product. Symmetric.
 */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  // `previous[j]` is the distance between left[0..i-1] and right[0..j-1];
  // `beforePrevious` is the row above that, which the transposition case
  // reaches back into.
  let beforePrevious: number[] = [];
  let previous: number[] = Array.from({ length: right.length + 1 }, (_unused, j) => j);

  for (let i = 1; i <= left.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= right.length; j++) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      let best = Math.min(
        current[j - 1]! + 1, // insertion
        previous[j]! + 1, // deletion
        previous[j - 1]! + substitutionCost, // substitution
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        best = Math.min(best, beforePrevious[j - 2]! + 1); // transposition
      }
      current.push(best);
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * The closest candidate to `target`, or undefined when none is close
 * enough to be worth naming.
 *
 * Undefined is a real answer, not a failure: pointing a caller at an
 * unrelated parameter is worse than telling them there is no near match,
 * because it sends them off to fix the wrong thing.
 *
 * Ties break on the candidate name itself, so the answer depends only on
 * the candidate SET and not on the order the caller happened to pass it
 * in. Two clients that send the same typo against the same schema get the
 * same sentence back.
 */
export function nearestName(target: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(target, candidate);
    if (distance > Math.max(target.length, candidate.length) * NEAREST_NAME_MAX_DISTANCE_RATIO) {
      continue;
    }
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
