/**
 * Evidence-pack coverage verification (recall-trust-suite, Feature C):
 * IDF-weighted coverage of the query terms over a candidate pool (the
 * partial self-correcting retry trigger) and over the returned result
 * set, plus the bounded per-token recall union that surfaces records the
 * primary ranking never returned.
 */

import { storeRecordJudge } from "./brain-store/entity-filter.ts";
import {
  buildCoverageReport,
  significantTerms,
  termIncludedIn,
  type CoverageReport,
} from "./coverage.ts";
import type { EvidenceVerification } from "./evidence-pack.ts";
import { runFtsQueryDetailed } from "./fts.ts";
import { Store } from "./store.ts";
import type { BrainSearchResult, EvidenceUnionRecord } from "./types.ts";

/**
 * The caller's admission rule over index references: which of the named
 * pages the caller may see. The union fetches straight from the keyword
 * lane, past the ranked pool, so it has to ask the same filters the main
 * result list runs (reach, visibility, owner, session/project scope,
 * status) or it names pages the caller's own search withholds.
 */
export type UnionAdmission = <T extends { readonly path: string; readonly documentId: number }>(
  refs: ReadonlyArray<T>,
) => ReadonlyArray<T>;

/** Cap on extra records fetched per uncovered term (Feature C union). */
const UNION_RECORDS_PER_TERM = 2;
/** Cap on the total recall-union fetch per query. */
const UNION_RECORDS_TOTAL = 8;
/**
 * Keyword hits fetched per uncovered term before the admission rule runs:
 * a withheld page must not crowd an admitted one out of the term's slots.
 */
const UNION_FETCH_PER_TERM = UNION_RECORDS_PER_TERM * 4;

/**
 * Coverage verification for evidence-pack mode (recall-trust-suite,
 * Feature C): corpus document frequencies for the significant terms,
 * the covered-term set over the returned results, and a bounded
 * per-token recall union — for each term the ranked set left uncovered,
 * fetch up to {@link UNION_RECORDS_PER_TERM} records that DO cover it
 * (evidence can span records the primary ranking never surfaced).
 */
/**
 * IDF-weighted coverage of the query over a candidate POOL (the partial
 * self-correcting retry trigger, t_8eb5ca32). Mirrors the result-set
 * coverage in {@link buildEvidenceVerification} but scores the
 * pre-ranking candidate chunks: a term is covered when any candidate's
 * path/title/content contains it. Corpus document frequencies and the
 * document count come from the store, exactly as the result-set pass
 * does, so the two reports share one definition of "covered" and one
 * IDF scale.
 */
export function coverageOverChunks(
  store: Store,
  query: string,
  chunkIds: ReadonlyArray<number>,
): CoverageReport {
  const terms = significantTerms(query);
  const dfByTerm = store.documentFrequencies(terms);
  const documentCount = store.counts().documents;
  const hydrated = store.hydrateChunks(chunkIds);
  const covered = new Set<string>();
  for (const h of hydrated.values()) {
    const haystack = `${h.path}\n${h.title ?? ""}\n${h.content}`;
    for (const t of terms) {
      if (!covered.has(t) && termIncludedIn(haystack, t)) covered.add(t);
    }
  }
  return buildCoverageReport({
    significantTerms: terms,
    coveredTerms: covered,
    documentCount,
    dfByTerm,
  });
}

/**
 * IDF-weighted coverage of the query over the RESULT SET a search is
 * about to return.
 *
 * Split out of {@link buildEvidenceVerification} because it is no longer
 * an evidence-pack-only quantity: it is the absolute match-quality number
 * every confidence threshold in the product now reads
 * (`SearchOutcome.idfWeightedCoverage`) - absolute as against a score,
 * not independent of `results`, which is exactly the argument it is
 * given. Evidence-pack mode calls
 * it through {@link buildEvidenceVerification}, which takes the finished
 * report rather than recomputing it, so one query performs exactly one
 * document-frequency read whichever mode it runs in.
 */
export function coverageOverResults(
  store: Store,
  query: string,
  results: ReadonlyArray<BrainSearchResult>,
): CoverageReport {
  const terms = significantTerms(query);
  const dfByTerm = store.documentFrequencies(terms);
  const documentCount = store.counts().documents;
  const covered = new Set<string>();
  for (const r of results) {
    const haystack = `${r.path}\n${r.title ?? ""}\n${r.content}`;
    for (const t of terms) {
      if (!covered.has(t) && termIncludedIn(haystack, t)) covered.add(t);
    }
  }
  return buildCoverageReport({
    significantTerms: terms,
    coveredTerms: covered,
    documentCount,
    dfByTerm,
  });
}

export function buildEvidenceVerification(
  store: Store,
  pathPrefix: string | undefined,
  /**
   * The coverage report the outcome already built for this exact result
   * set. A parameter rather than a second computation: an internally
   * rebuilt report would buy a second document-frequency read, and a
   * report built over a DIFFERENT result set would make the evidence pack
   * disagree with the outcome's own match quality.
   */
  coverage: CoverageReport,
  /**
   * Required, with no permissive default: a caller that forgets it would
   * get the unfiltered union, so the type makes forgetting impossible.
   */
  admit: UnionAdmission,
): EvidenceVerification {
  const unionRecords: EvidenceUnionRecord[] = [];
  // Straight from the keyword lane, past every pool filter: a store record
  // the store rule hides is never named here (`brain-store/entity-filter.ts`).
  const shown = storeRecordJudge(store);
  for (const t of coverage.terms) {
    if (t.covered || t.df === 0) continue; // nothing in the corpus covers a df=0 term
    if (unionRecords.length >= UNION_RECORDS_TOTAL) break;
    const outcome = runFtsQueryDetailed(store, t.term, {
      limit: UNION_FETCH_PER_TERM,
      pathPrefix,
    });
    const ids = outcome.hits.map((h) => h.chunkId);
    const hydrated = store.hydrateChunks(ids);
    const named = outcome.hits.flatMap((hit) => {
      const h = hydrated.get(hit.chunkId);
      return h === undefined || !shown(h.path) ? [] : [h];
    });
    let perTerm = 0;
    for (const h of admit(named)) {
      if (unionRecords.length >= UNION_RECORDS_TOTAL || perTerm >= UNION_RECORDS_PER_TERM) break;
      perTerm++;
      unionRecords.push(
        Object.freeze({
          term: t.term,
          path: h.path,
          documentId: h.documentId,
          chunkId: h.chunkId,
        }),
      );
    }
  }
  return Object.freeze({ coverage, unionRecords: Object.freeze(unionRecords) });
}
