/**
 * Trigram candidate prefilter (Retrieval & Ranking Quality, t_4a672b84).
 *
 * A deterministic planner over the `chunk_trigram` FTS5 shadow (schema v9).
 * Given a query it decides whether to gather trigram candidates and, if so,
 * builds the FTS5 MATCH string. The trigram source is a STRICT SUPERSET of
 * exact substring matches for the query's terms, so unioning it into the
 * candidate pool can only add candidates the word-tokenized keyword lane
 * missed (substring / partial-token matches) - it never drops a result.
 *
 * It falls back to the normal path (no trigram source) for:
 *   - short queries      (no term of at least 3 characters - the trigram
 *                          tokenizer's minimum token width),
 *   - CJK queries        (already covered by the v5 CJK fts_content
 *                          expansion; trigram shingling over ideographs is
 *                          redundant and low-precision here),
 *   - low-selectivity    (the term set matches too large a fraction of the
 *                          corpus to be worth widening - judged post-query).
 *
 * Pure and dependency-free: the SQLite `trigram` tokenizer does the
 * indexing; this module only plans queries and judges selectivity.
 */

/** Minimum term length the trigram tokenizer can match. */
export const TRIGRAM_MIN_TERM_LEN = 3;

const CJK_RE = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/;

/** True when the text contains any CJK (Han/Kana/Hangul) codepoint. */
export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/**
 * Split a query into candidate trigram terms: alphanumeric runs of at
 * least {@link TRIGRAM_MIN_TERM_LEN} characters, lower-cased. Terms shorter
 * than the trigram width cannot be matched and are dropped.
 */
export function extractTrigramTerms(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= TRIGRAM_MIN_TERM_LEN) out.push(raw);
  }
  return out;
}

/** Escape a term for use as an FTS5 quoted string (double any `"`). */
function escapeFts5(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Outcome of planning a trigram prefilter for a query. */
export type TrigramPlan =
  | { readonly mode: "skip"; readonly reason: "short" | "cjk" }
  | { readonly mode: "match"; readonly ftsQuery: string; readonly terms: ReadonlyArray<string> };

/**
 * Plan the trigram prefilter for a query. Returns a `skip` decision
 * (with the reason) when the query does not qualify, or a `match` with the
 * conjunctive FTS5 query over the qualifying terms. Selectivity is judged
 * separately (post-query) via {@link isLowSelectivity}.
 */
export function planTrigramPrefilter(query: string): TrigramPlan {
  if (containsCjk(query)) return { mode: "skip", reason: "cjk" };
  const terms = extractTrigramTerms(query);
  if (terms.length === 0) return { mode: "skip", reason: "short" };
  // Conjunctive AND: a chunk must contain every term's trigrams. This is a
  // superset of "contains every term as a substring".
  const ftsQuery = terms.map(escapeFts5).join(" AND ");
  return { mode: "match", ftsQuery, terms };
}

/**
 * A trigram candidate set is "low-selectivity" (not worth widening the
 * pool with) when it covers more than `maxSelectivity` of the corpus.
 * Returns false for an empty corpus.
 */
export function isLowSelectivity(
  candidateCount: number,
  corpusChunkCount: number,
  maxSelectivity: number,
): boolean {
  if (corpusChunkCount <= 0) return false;
  return candidateCount / corpusChunkCount > maxSelectivity;
}
