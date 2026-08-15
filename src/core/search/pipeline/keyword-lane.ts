/**
 * Keyword candidate lane: the FTS pass, the opt-in synonym re-run that
 * broadens it, and the opt-in trigram prefilter that merges substring
 * matches the word tokenizer missed. Owns the query plan, because the
 * synonym step is what folds derived terms into it.
 */

import { runFtsQueryDetailed } from "../fts.ts";
import { buildQueryPlan } from "../query-plan.ts";
import type { RetrievalDegradationSink } from "../retrieval-trail.ts";
import { DEFAULT_EXPANSION, deriveExpansionTerms, tokenizeForExpansion } from "../synonyms.ts";
import { isLowSelectivity, planTrigramPrefilter } from "../trigram-prefilter.ts";
import type { KeywordHit, Store } from "../store.ts";
import type { TemporalIntent } from "../temporal-intent.ts";
import type { QueryIntent, QueryPlan } from "../types.ts";

/** Top candidates whose own content seeds the synonym derivation. */
const SYNONYM_SEED_HITS = 10;

export interface KeywordLaneInput {
  readonly store: Store;
  readonly recall: {
    readonly poolMultiplier: number;
    readonly synonymEnabled: boolean;
    readonly synonymMaxTerms: number;
    readonly trigramPrefilterEnabled: boolean;
    readonly trigramPrefilterMinChunks: number;
    readonly trigramPrefilterMaxSelectivity: number;
  };
  /** Residual query text, for the term derivations that read prose. */
  readonly query: string;
  /** The lane's FTS query (structured lex lane, else the residual text). */
  readonly keywordQuery: string;
  readonly structuredIntent: QueryIntent | null | undefined;
  readonly surfaceVocabulary: ReadonlySet<string>;
  readonly nowMs: number;
  readonly temporalIntent: TemporalIntent | null;
  readonly basePlan: QueryPlan;
  readonly limit: number;
  readonly pathPrefix: string | undefined;
}

export interface KeywordLaneOutcome {
  /** Mutable: later stages merge retry candidates into this pool. */
  readonly hits: KeywordHit[];
  /** The base plan, or a re-plan carrying the derived expansion terms. */
  readonly plan: QueryPlan;
  readonly warnings: string[];
  /**
   * The typed half of {@link warnings} (evidence-at-the-boundary, C2):
   * one code per narrowing, pushed where the sentence is pushed.
   */
  readonly degraded: RetrievalDegradationSink;
}

export function runKeywordLane(input: KeywordLaneInput): KeywordLaneOutcome {
  const { store, recall, keywordQuery, limit, pathPrefix } = input;
  const warnings: string[] = [];
  const degraded: RetrievalDegradationSink = [];

  const kwOutcome = runFtsQueryDetailed(store, keywordQuery, {
    limit: limit * recall.poolMultiplier,
    pathPrefix,
    degraded,
  });
  let hits = kwOutcome.hits;
  for (const w of kwOutcome.warnings) warnings.push(w);

  // Synonym / query expansion (v0.20.0): opt-in and never for an
  // exact-intent (quoted/wildcard) query. Derive related terms from
  // the top candidates' own content (local co-occurrence) and re-run
  // FTS with them OR'd onto the original query to broaden recall. A
  // no-op - byte-identical hits - when disabled or no term qualifies.
  let plan = input.basePlan;
  if (recall.synonymEnabled && input.basePlan.intent !== "exact" && hits.length > 0) {
    const expanded = expandWithSynonyms(input, hits);
    if (expanded !== null) {
      plan = expanded.plan;
      hits = expanded.hits;
      for (const w of expanded.warnings) warnings.push(w);
    }
  }

  // Trigram candidate source (t_4a672b84): opt-in. On large vaults, merge
  // substring / partial-token matches the word tokenizer missed into the
  // keyword candidate pool. A strict superset of substring matches, so it
  // only ADDS candidates (deduped by chunkId; existing keyword hits keep
  // their bm25). Skipped for short/CJK/low-selectivity queries and when
  // disabled - leaving hits byte-identical.
  if (recall.trigramPrefilterEnabled && store.chunkCount() >= recall.trigramPrefilterMinChunks) {
    mergeTrigramCandidates(input, hits, warnings, degraded);
  }

  return { hits, plan, warnings, degraded };
}

/**
 * Re-plan and re-run the lane with terms derived from the top candidates'
 * own content. Null when no term qualified, leaving the first pass intact.
 */
function expandWithSynonyms(
  input: KeywordLaneInput,
  hits: KeywordHit[],
): { plan: QueryPlan; hits: KeywordHit[]; warnings: ReadonlyArray<string> } | null {
  const { store, recall, query, keywordQuery, limit, pathPrefix } = input;
  const topIds = hits.slice(0, SYNONYM_SEED_HITS).map((h) => h.chunkId);
  const ctx = store.hydrateChunks(topIds);
  const texts = topIds.map((id) => ctx.get(id)?.content ?? "").filter((t) => t.length > 0);
  const expandedTerms = deriveExpansionTerms(tokenizeForExpansion(query), texts, {
    ...DEFAULT_EXPANSION,
    maxTerms: recall.synonymMaxTerms,
  });
  if (expandedTerms.length === 0) return null;
  const plan = buildQueryPlan(
    keywordQuery,
    expandedTerms,
    input.structuredIntent,
    input.surfaceVocabulary,
    input.nowMs,
    input.temporalIntent,
  );
  const kwOutcome = runFtsQueryDetailed(store, keywordQuery, {
    limit: limit * recall.poolMultiplier,
    pathPrefix,
    expandedTerms,
  });
  return { plan, hits: kwOutcome.hits, warnings: kwOutcome.warnings };
}

/**
 * Append the trigram candidates the keyword pool does not already hold.
 * The lane only broadens the pool, so a fault in it degrades this step
 * (no candidates, one warning) rather than failing the search.
 */
function mergeTrigramCandidates(
  input: KeywordLaneInput,
  hits: KeywordHit[],
  warnings: string[],
  degraded: RetrievalDegradationSink,
): void {
  const { store, recall, query, limit, pathPrefix } = input;
  const trigramPlan = planTrigramPrefilter(query);
  if (trigramPlan.mode !== "match") return;
  const corpus = store.chunkCount();
  const outcome = store.trigramCandidates(trigramPlan.ftsQuery, {
    limit: limit * recall.poolMultiplier,
    pathPrefix,
  });
  for (const w of outcome.warnings) warnings.push(w);
  for (const d of outcome.degraded) degraded.push(d);
  const cand = outcome.hits;
  if (cand.length === 0) return;
  if (isLowSelectivity(cand.length, corpus, recall.trigramPrefilterMaxSelectivity)) return;
  const seen = new Set(hits.map((h) => h.chunkId));
  for (const h of cand) {
    if (!seen.has(h.chunkId)) {
      hits.push(h);
      seen.add(h.chunkId);
    }
  }
}
