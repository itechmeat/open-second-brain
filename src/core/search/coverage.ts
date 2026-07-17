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

import type { CompletenessReport, CompletenessVerdict } from "./types.ts";

/** Share of the corpus a term may appear in and still count as rare. */
export const RARE_TERM_CORPUS_SHARE = 0.02;

/**
 * Significant query terms: length >= 3, deduplicated, in query order.
 *
 * Language-agnostic by construction: there is deliberately NO stopword
 * list. A per-language stopword set (the old English-only one) would
 * under-filter every other language while pretending to help. Instead,
 * corpus-common terms are handled downstream by the IDF weighting in
 * {@link buildCoverageReport} — a term that appears in most documents
 * earns near-zero IDF and contributes almost nothing to the weighted
 * coverage, in any language, without a vocabulary list.
 */
export function significantTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (token.length >= 3) terms.add(token);
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

/**
 * Targeted self-correcting retry plan (t_8eb5ca32): the deterministic
 * decision that connects coverage to a follow-up retrieval. A retry
 * fires only when the IDF-weighted coverage is below the completeness
 * threshold AND at least one RARE significant term is still uncovered;
 * the follow-up is then aimed at exactly those uncovered rare terms —
 * the specifically-missing high-signal facts — never a generic
 * broadening of the whole query. The rare gate keeps the retry off when
 * only corpus-common terms are missing (low IDF, low value) and bounds
 * how often it can fire. `terms` is empty iff `fire` is false.
 *
 * Pure and deterministic: a verdict over an already-built report, no
 * I/O. The caller decides how to turn the terms into a query (FTS OR,
 * expansion, …) and how to cap the number of passes.
 */
export interface TargetedRetryPlan {
  readonly fire: boolean;
  readonly terms: ReadonlyArray<string>;
}

export function planTargetedRetry(coverage: CoverageReport): TargetedRetryPlan {
  const belowThreshold = coverage.idfWeightedCoverage < COMPLETENESS_COMPLETE_THRESHOLD;
  const fire = belowThreshold && coverage.uncoveredRareTerms.length > 0;
  return Object.freeze({
    fire,
    terms: fire ? coverage.uncoveredRareTerms : Object.freeze([] as string[]),
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
