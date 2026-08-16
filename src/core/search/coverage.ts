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
 * Significant query terms: every word-character run, deduplicated, in
 * query order.
 *
 * Language-agnostic by construction: there is deliberately NO stopword
 * list. A per-language stopword set (the old English-only one) would
 * under-filter every other language while pretending to help. Instead,
 * corpus-common terms are handled downstream by the IDF weighting in
 * {@link buildCoverageReport} — a term that appears in most documents
 * earns near-zero IDF and contributes almost nothing to the weighted
 * coverage, in any language, without a vocabulary list.
 *
 * ## Why there is no length floor any more
 *
 * There used to be one: a token had to be three characters. It was a
 * stopword list in disguise, written for a script whose function words
 * are short and whose content words are not, and it did not survive
 * contact with a script where the common word length IS one or two
 * characters. `検索` ("search") is two characters and was dropped whole;
 * so was every one- and two-character Chinese or Japanese query, which
 * left the report with nothing to weigh and — before this changed —
 * scoring a perfect 1.0 for a retrieval that matched nothing.
 *
 * A character count cannot be made script-neutral: the same count means
 * "a function word" in one writing system and "a full noun" in another.
 * So the count is gone rather than tuned, and the job it was pretending
 * to do is left where it was always actually done, in the IDF weight. A
 * one-character term that appears in most documents earns near-zero IDF
 * in exactly the same way a three-character one does; a one-character
 * term that appears in two documents is a discriminating term and is now
 * treated as one.
 *
 * The visible cost is on the preview surfaces that share this splitter:
 * `matchOffset` can now anchor a snippet on a one-character common word
 * where it previously anchored on a three-character one. That cost is
 * the same one its docblock already accepted, one character smaller.
 */
export function significantTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    // At least one letter or digit. The splitter keeps `-` and `_` inside
    // a token so `well-known` and `snake_case` survive whole, which means
    // a run of pure punctuation (`--`) also survives the split; it is not
    // a word in any language, and with the length floor gone nothing else
    // would have stopped it from earning IDF mass.
    if (HAS_WORD_CHARACTER.test(token)) terms.add(token);
  }
  return [...terms];
}

/** A token counts as a word once it carries one letter or digit. */
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

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
 * A term is rare (high-signal) when it appears in at most `corpusShare` of
 * the corpus, with a floor of one document so tiny corpora still classify
 * their unique terms as rare.
 *
 * `corpusShare` defaults to {@link RARE_TERM_CORPUS_SHARE}, the vault-corpus
 * value this function was written for. It is a parameter because the same
 * classification - corpus document frequency against a share of the corpus,
 * with no vocabulary list anywhere in it - is what separates a
 * discriminating term from a corpus-common one in the far smaller skill
 * descriptor corpus (t_ccb05134). The share differs by corpus; the shape
 * must not, or the two would drift into disagreeing about what "common"
 * means.
 */
export function isRareTerm(
  df: number,
  documentCount: number,
  corpusShare: number = RARE_TERM_CORPUS_SHARE,
): boolean {
  return df <= Math.max(1, Math.floor(corpusShare * documentCount));
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
   *
   * `null` when the query carries no IDF mass to weigh at all — see
   * {@link buildCoverageReport}. NOT a number, deliberately: the previous
   * shape reported that case as `1`, so a query nothing could be measured
   * about was indistinguishable from a complete retrieval, and every
   * threshold reading it fired at maximum confidence. A nullable field
   * makes the type system ask each consumer what it wants to do about an
   * unmeasurable query, which is the same question the code was silently
   * answering "perfect" to.
   */
  readonly idfWeightedCoverage: number | null;
  readonly rareTerms: ReadonlyArray<string>;
  readonly uncoveredRareTerms: ReadonlyArray<string>;
}

/** IDF-weighted coverage at/above this is a complete retrieval. */
export const COMPLETENESS_COMPLETE_THRESHOLD = 0.8;
/** IDF-weighted coverage at/above this (below complete) is partial. */
export const COMPLETENESS_PARTIAL_THRESHOLD = 0.4;

/**
 * The three-way verdict, plus the fourth state that is not a verdict.
 *
 * An unmeasurable coverage (`null`) becomes `unmeasurable` rather than
 * being folded into `sparse`: "the retrieval missed" and "there was
 * nothing here to weigh" call for different repairs, and reporting the
 * second as the first would tell a reader the corpus is thin when the
 * measurement never ran.
 */
export function buildCompletenessReport(coverage: CoverageReport): CompletenessReport {
  const covered = coverage.terms.filter((t) => t.covered).map((t) => t.term);
  const uncovered = coverage.terms.filter((t) => !t.covered);
  const weighted = coverage.idfWeightedCoverage;
  const verdict: CompletenessVerdict =
    weighted === null
      ? "unmeasurable"
      : weighted >= COMPLETENESS_COMPLETE_THRESHOLD
        ? "complete"
        : weighted >= COMPLETENESS_PARTIAL_THRESHOLD
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
  // An unmeasurable coverage does not fire the retry. Stated rather than
  // left to the empty rare-term list that would also stop it: a retry
  // aimed at "the specifically-missing high-signal facts" needs a
  // measurement naming them, and there is none.
  const belowThreshold =
    coverage.idfWeightedCoverage !== null &&
    coverage.idfWeightedCoverage < COMPLETENESS_COMPLETE_THRESHOLD;
  const fire = belowThreshold && coverage.uncoveredRareTerms.length > 0;
  return Object.freeze({
    fire,
    terms: fire ? coverage.uncoveredRareTerms : Object.freeze([] as string[]),
  });
}

/**
 * The report, and the one condition under which there is no number.
 *
 * `idfWeightedCoverage` is a SHARE of the query's IDF mass, so it exists
 * only when there is mass to take a share of. Two inputs leave none: a
 * query with no word characters at all, and a corpus with no documents
 * (every `idfForTerm` is then `ln(1) = 0`). Both are reported as `null`,
 * because neither is a statement about how well the retrieval did.
 */
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
    // No IDF mass means there is nothing to take a share OF, so there is
    // no coverage — not full coverage. `null`, and every consumer decides.
    idfWeightedCoverage: totalIdf === 0 ? null : coveredIdf / totalIdf,
    rareTerms: Object.freeze(rareTerms),
    uncoveredRareTerms: Object.freeze(uncoveredRareTerms),
  });
}
