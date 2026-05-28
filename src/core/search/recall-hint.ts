/**
 * Recall hint for brain_search results (v0.18.0).
 *
 * A computed-at-recall-time, never-stored summary that tells the calling
 * agent how to read the recalled set: how many matched, the per-type
 * breakdown, and the top hit. It complements each result's `reasons[]`
 * (why_retrieved) with a one-line orientation over the whole set.
 *
 * Language-agnostic by construction: the string is built from a single
 * English template plus numbers and identifiers already present in the
 * data (search type, score, title). There is no per-locale phrase table -
 * the project ships one authoring language and translation, if ever
 * wanted, is a host concern, not a stored taxonomy.
 */

const MAX_TITLE_CHARS = 80;

export interface RecallHintInput {
  readonly searchType: string;
  readonly score: number;
  readonly title: string | null;
}

function trimTitle(title: string | null): string {
  if (!title) return "(untitled)";
  if (title.length <= MAX_TITLE_CHARS) return title;
  return title.slice(0, MAX_TITLE_CHARS - 1) + "…";
}

/**
 * Build the recall hint, or `null` when there is nothing to summarise.
 * `results` is assumed already ranked (best first), matching the search
 * pipeline's output order.
 */
export function deriveRecallHint(
  results: ReadonlyArray<RecallHintInput>,
  total: number,
): string | null {
  if (results.length === 0) return null;

  const counts = new Map<string, number>();
  for (const r of results) {
    counts.set(r.searchType, (counts.get(r.searchType) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type}`)
    .join(", ");

  const top = results[0]!;
  // `total` is the corpus match count and should be >= the returned slice;
  // guard against a caller passing a smaller total so the string never
  // reads "Recalled 10 of 3".
  const denom = Math.max(total, results.length);
  return (
    `Recalled ${results.length} of ${denom} matches (${breakdown}). ` +
    `Top hit "${trimTitle(top.title)}" (${top.searchType}, score ${top.score.toFixed(2)}). ` +
    `See each result's reasons[] for why it surfaced.`
  );
}
