/**
 * Coverage engine (recall-trust-suite, Features C and E).
 *
 * The single source of truth for query-term verification: significant
 * terms, per-term coverage postings, corpus document frequency turned
 * into IDF weight, and the rare-term classification. Both the verified
 * multi-record recall pass (Feature C: union fetch, IDF-weighted
 * support, rare-term abstention) and the search-completeness guard
 * (Feature E) read this one report, so the two can never disagree about
 * what "covered" means.
 *
 * Pure module — callers (search.ts / evidence-pack.ts) gather document
 * counts and per-term document frequencies from the store and hand them
 * in. Deterministic, no LLM, no clock.
 */

const STOPWORDS = new Set([
  "about",
  "and",
  "are",
  "for",
  "from",
  "how",
  "the",
  "this",
  "that",
  "what",
  "when",
  "where",
  "with",
]);

/** Share of the corpus a term may appear in and still count as rare. */
export const RARE_TERM_CORPUS_SHARE = 0.02;

/**
 * Significant query terms: length >= 3, not a stopword, deduplicated,
 * in query order. The same extraction the evidence pack has used since
 * PR #54 — now owned here so every consumer agrees.
 */
export function significantTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (token.length >= 3 && !STOPWORDS.has(token)) terms.add(token);
  }
  return [...terms];
}

/** Case-folded containment check shared by pack record building. */
export function termIncludedIn(haystack: string, term: string): boolean {
  return haystack.toLocaleLowerCase().includes(term);
}

/**
 * Smoothed inverse document frequency: `ln(1 + N / (1 + df))`. Always
 * positive (even a term in every document keeps a small weight), higher
 * for rarer terms, and stable for df = 0.
 */
export function idfForTerm(df: number, documentCount: number): number {
  const n = Math.max(0, documentCount);
  const d = Math.max(0, df);
  return Math.log(1 + n / (1 + d));
}

/**
 * A term is rare (high-signal) when it appears in at most
 * `RARE_TERM_CORPUS_SHARE` of the corpus, with a floor of one document
 * so tiny corpora still classify their unique terms as rare.
 */
export function isRareTerm(df: number, documentCount: number): boolean {
  return df <= Math.max(1, Math.floor(RARE_TERM_CORPUS_SHARE * documentCount));
}

export interface TermCoverage {
  readonly term: string;
  readonly df: number;
  readonly idf: number;
  readonly rare: boolean;
  readonly covered: boolean;
}

export interface CoverageInputs {
  readonly significantTerms: ReadonlyArray<string>;
  /** Terms at least one returned result contains. */
  readonly coveredTerms: ReadonlySet<string>;
  readonly documentCount: number;
  /** Corpus document frequency per significant term (absent → 0). */
  readonly dfByTerm: ReadonlyMap<string, number>;
}

export interface CoverageReport {
  readonly terms: ReadonlyArray<TermCoverage>;
  /**
   * Support coverage weighted by IDF: the share of the query's total
   * IDF mass the covered terms carry. A result set matching only the
   * common words scores low even when it matches most terms by count.
   */
  readonly idfWeightedCoverage: number;
  readonly rareTerms: ReadonlyArray<string>;
  readonly uncoveredRareTerms: ReadonlyArray<string>;
}

/** IDF-weighted coverage at/above this is a complete retrieval. */
export const COMPLETENESS_COMPLETE_THRESHOLD = 0.8;
/** IDF-weighted coverage at/above this (below complete) is partial. */
export const COMPLETENESS_PARTIAL_THRESHOLD = 0.4;

export type CompletenessVerdict = "complete" | "partial" | "sparse";

/**
 * Search-completeness guard (Feature E): a deterministic verdict over
 * how well the returned results cover the query, plus the
 * false-absence guard — uncovered terms the corpus DOES contain. A
 * summarizer seeing a term in `uncoveredButPresentInCorpus` cannot
 * honestly claim the vault has nothing on it.
 */
export interface CompletenessReport {
  readonly verdict: CompletenessVerdict;
  readonly idfWeightedCoverage: number;
  readonly coveredTerms: ReadonlyArray<string>;
  readonly uncoveredTerms: ReadonlyArray<string>;
  readonly uncoveredButPresentInCorpus: ReadonlyArray<string>;
}

export function buildCompletenessReport(coverage: CoverageReport): CompletenessReport {
  const covered = coverage.terms.filter((t) => t.covered).map((t) => t.term);
  const uncovered = coverage.terms.filter((t) => !t.covered);
  const verdict: CompletenessVerdict =
    coverage.idfWeightedCoverage >= COMPLETENESS_COMPLETE_THRESHOLD
      ? "complete"
      : coverage.idfWeightedCoverage >= COMPLETENESS_PARTIAL_THRESHOLD
        ? "partial"
        : "sparse";
  return Object.freeze({
    verdict,
    idfWeightedCoverage: coverage.idfWeightedCoverage,
    coveredTerms: Object.freeze(covered),
    uncoveredTerms: Object.freeze(uncovered.map((t) => t.term)),
    uncoveredButPresentInCorpus: Object.freeze(
      uncovered.filter((t) => t.df > 0).map((t) => t.term),
    ),
  });
}

export function buildCoverageReport(inputs: CoverageInputs): CoverageReport {
  const terms: TermCoverage[] = inputs.significantTerms.map((term) => {
    const df = inputs.dfByTerm.get(term) ?? 0;
    return Object.freeze({
      term,
      df,
      idf: idfForTerm(df, inputs.documentCount),
      rare: isRareTerm(df, inputs.documentCount),
      covered: inputs.coveredTerms.has(term),
    });
  });
  let totalIdf = 0;
  let coveredIdf = 0;
  for (const t of terms) {
    totalIdf += t.idf;
    if (t.covered) coveredIdf += t.idf;
  }
  const rareTerms = terms.filter((t) => t.rare).map((t) => t.term);
  const uncoveredRareTerms = terms.filter((t) => t.rare && !t.covered).map((t) => t.term);
  return Object.freeze({
    terms: Object.freeze(terms),
    idfWeightedCoverage: totalIdf === 0 ? 1 : coveredIdf / totalIdf,
    rareTerms: Object.freeze(rareTerms),
    uncoveredRareTerms: Object.freeze(uncoveredRareTerms),
  });
}
