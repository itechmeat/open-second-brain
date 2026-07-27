/**
 * Query shape: how the caller's text becomes the two lane queries and the
 * structural plan they are ranked under. Resolves the structured recall
 * document (explicit or expanded), splits it into the keyword and semantic
 * lane queries, and builds the base query plan whose hash keys the cache.
 *
 * Both vocabularies consulted here are config-derived token sets - never a
 * natural-language word list.
 */

import { loadSchemaPack } from "../../brain/schema-pack.ts";
import { buildQueryPlan } from "../query-plan.ts";
import { expandQuery } from "../query-expansion.ts";
import { structuredKeywordQuery, structuredSemanticQuery } from "../structured-lanes.ts";
import { tokenizeForExpansion } from "../synonyms.ts";
import type { Store } from "../store.ts";
import type { TemporalIntent } from "../temporal-intent.ts";
import type { QueryPlan, StructuredRecallQueryDocument } from "../types.ts";

/** A token in at least this share of the corpus is treated as common. */
const COMMON_TOKEN_CORPUS_SHARE = 0.5;
/**
 * Floor on document frequency before a token can be "common". Below this
 * a corpus is too small to tell a stopword-like word from a rare one, so
 * nothing is flagged (a 2-document vault must not call a word that appears
 * once "ubiquitous").
 */
const MIN_COMMON_DOCUMENT_FREQUENCY = 2;

/**
 * Corpus-common query tokens, derived from document frequency. A token
 * present in at least {@link COMMON_TOKEN_CORPUS_SHARE} of the indexed
 * documents (and in at least {@link MIN_COMMON_DOCUMENT_FREQUENCY} of
 * them) carries little discriminating signal - in ANY language - so the
 * lex expansion lane drops it rather than letting one ubiquitous word
 * kill an implicit-AND match. Language-agnostic: no stopword list.
 *
 * Note: document frequency is measured through the FTS index, whose
 * tokenization can differ slightly from `tokenizeForExpansion`. A miss
 * only fails to flag a token as common (it stays in the lex lane), so the
 * fallback is always the safe, non-lossy direction.
 */
function highFrequencyTokens(store: Store, query: string): ReadonlySet<string> {
  const tokens = [...new Set(tokenizeForExpansion(query))];
  if (tokens.length === 0) return new Set();
  const documentCount = store.counts().documents;
  if (documentCount === 0) return new Set();
  const threshold = COMMON_TOKEN_CORPUS_SHARE * documentCount;
  const df = store.documentFrequencies(tokens);
  const common = new Set<string>();
  for (const token of tokens) {
    const freq = df.get(token) ?? 0;
    if (freq >= MIN_COMMON_DOCUMENT_FREQUENCY && freq >= threshold) common.add(token);
  }
  return common;
}

/**
 * The artifact-kind vocabulary for the summary-search router (t_7b96f242):
 * the schema pack's declared page types, already normalized. This is the
 * ONLY place artifact-kind vocabulary enters the surface router - a
 * config-derived token set, never a natural-language word list. An
 * unreadable pack yields an empty set, so the router falls back to the
 * vocabulary-independent source signal only.
 */
function summarySurfaceVocabulary(vault: string): ReadonlySet<string> {
  try {
    return new Set(loadSchemaPack(vault).vocabulary.page_types.map((t) => t.toLowerCase()));
  } catch {
    return new Set<string>();
  }
}

export interface QueryShapeInput {
  readonly store: Store;
  readonly vault: string;
  /** Residual query text (time directives already stripped). */
  readonly query: string;
  /** An explicit structured document from the caller, if any. */
  readonly structuredQuery: StructuredRecallQueryDocument | undefined;
  /** Whether opt-in local expansion runs. */
  readonly expandActive: boolean;
  readonly nowMs: number;
  readonly temporalIntent: TemporalIntent | null;
}

export interface QueryShape {
  readonly structured: StructuredRecallQueryDocument | undefined;
  readonly keywordQuery: string;
  readonly semanticLaneQuery: string | null;
  readonly surfaceVocabulary: ReadonlySet<string>;
  readonly basePlan: QueryPlan;
}

export function resolveQueryShape(input: QueryShapeInput): QueryShape {
  const { store, vault, query, structuredQuery, expandActive, nowMs, temporalIntent } = input;
  // Opt-in local expansion (t_2fa95db1): an explicit structured
  // document always wins; expansion only fills the gap. The lex lane's
  // corpus-common tokens are derived from document frequency here
  // (language-agnostic, no stopword list) so an implicit-AND query is
  // not killed by a word that is ubiquitous in this vault.
  // Expansion reads the RESIDUAL text (see the strip in request
  // resolution): a window directive is an instruction, so it must never
  // become an expansion token, and the residual is byte-identical when no
  // window was declared.
  const commonTokens =
    structuredQuery === undefined && expandActive === true
      ? highFrequencyTokens(store, query)
      : new Set<string>();
  const structured =
    structuredQuery ??
    (expandActive === true ? expandQuery(vault, query, { commonTokens }) : undefined);
  const keywordQuery = structuredKeywordQuery(query, structured);
  const semanticLaneQuery = structuredSemanticQuery(structured);
  // Query plan (v0.20.0): one structural pass yields the intent weight
  // profile and the cache key. Expanded terms (if any) are folded in
  // once they have been derived from the store by the keyword lane.
  const surfaceVocabulary = summarySurfaceVocabulary(vault);
  const basePlan = buildQueryPlan(
    keywordQuery,
    [],
    structured?.intent,
    surfaceVocabulary,
    nowMs,
    temporalIntent,
  );
  return { structured, keywordQuery, semanticLaneQuery, surfaceVocabulary, basePlan };
}
