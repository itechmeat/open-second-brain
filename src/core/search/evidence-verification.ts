/**
 * Evidence-pack coverage verification (recall-trust-suite, Feature C):
 * IDF-weighted coverage of the query terms over a candidate pool (the
 * partial self-correcting retry trigger) and over the returned result
 * set, plus the bounded per-token recall union that surfaces records the
 * primary ranking never returned.
 */

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

/** Cap on extra records fetched per uncovered term (Feature C union). */
const UNION_RECORDS_PER_TERM = 2;
/** Cap on the total recall-union fetch per query. */
const UNION_RECORDS_TOTAL = 8;

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

export function buildEvidenceVerification(
  store: Store,
  query: string,
  results: ReadonlyArray<BrainSearchResult>,
  pathPrefix: string | undefined,
): EvidenceVerification {
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
  const coverage = buildCoverageReport({
    significantTerms: terms,
    coveredTerms: covered,
    documentCount,
    dfByTerm,
  });

  const unionRecords: EvidenceUnionRecord[] = [];
  for (const t of coverage.terms) {
    if (t.covered || t.df === 0) continue; // nothing in the corpus covers a df=0 term
    if (unionRecords.length >= UNION_RECORDS_TOTAL) break;
    const outcome = runFtsQueryDetailed(store, t.term, {
      limit: UNION_RECORDS_PER_TERM,
      pathPrefix,
    });
    const ids = outcome.hits.map((h) => h.chunkId);
    const hydrated = store.hydrateChunks(ids);
    for (const hit of outcome.hits) {
      if (unionRecords.length >= UNION_RECORDS_TOTAL) break;
      const h = hydrated.get(hit.chunkId);
      if (!h) continue;
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
