/**
 * Pure query analysis (v0.20.0): the single seam where a query is
 * inspected before retrieval. It produces a {@link QueryPlan} carrying a
 * structural intent, a bounded ranking {@link WeightProfile}, the
 * synonym-expansion terms (populated by `synonyms.ts`), and a stable
 * `planHash` used in the query-cache key.
 *
 * LANGUAGE-AGNOSTIC INVARIANT (audited here, in one place): intent and
 * expansion derive ONLY from structural signals - quoted spans, FTS
 * wildcards, wikilink shapes, the share of entity-like tokens (via the
 * already-structural `extractEntities`), and token count. No
 * natural-language word, synonym, or stopword list appears anywhere. The
 * classifier behaves identically across scripts and locales.
 *
 * The module is pure and deterministic: same query string in, same plan
 * out, with no I/O and no clock/random source.
 */

import { extractEntities } from "./entities.ts";
import type { QueryIntent, QueryPlan, WeightProfile } from "./types.ts";

/** No-effect profile: every layer keeps its configured weight. */
export const NEUTRAL_PROFILE: WeightProfile = Object.freeze({
  keywordMul: 1,
  semanticMul: 1,
  entityMul: 1,
  recencyMul: 1,
});

/**
 * Fixed structural-feature -> profile table. Every multiplier stays
 * within [0.7, 1.4], so a (mis)classification can only re-weight an
 * already-relevant set, never float an unrelated document.
 */
const PROFILES: Record<QueryIntent, WeightProfile> = Object.freeze({
  neutral: NEUTRAL_PROFILE,
  // Literal lookup: trust the keyword/FTS layer, discount fuzzy semantic.
  exact: Object.freeze({ keywordMul: 1.3, semanticMul: 0.7, entityMul: 1, recencyMul: 1 }),
  // Proper-noun lookup: amplify the entity layer, nudge keyword.
  entity: Object.freeze({ keywordMul: 1.15, semanticMul: 0.9, entityMul: 1.4, recencyMul: 1 }),
  // Open-ended exploration: lean on semantic similarity and recency.
  broad: Object.freeze({ keywordMul: 0.9, semanticMul: 1.2, entityMul: 1, recencyMul: 1.1 }),
});

const QUOTED_PHRASE_RE = /"[^"\n]{2,}"/u;
const WILDCARD_RE = /\*/u;
const WIKILINK_RE = /\[\[[^\]\n]+\]\]/u;

/** Lowercase + trim + collapse internal whitespace. No word lists. */
function normalize(query: string): string {
  return query.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** Deterministic FNV-1a 32-bit hash, hex-encoded. No crypto/I/O. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept in uint32.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Token count over normalized whitespace. Empty string -> 0. */
function tokenCount(normalized: string): number {
  if (normalized === "") return 0;
  return normalized.split(" ").length;
}

function classify(query: string, normalized: string): QueryIntent {
  if (normalized === "") return "neutral";

  // Rule 1: a literal phrase or prefix wildcard means the caller wants
  // an exact textual hit - favour the keyword layer.
  if (QUOTED_PHRASE_RE.test(query) || WILDCARD_RE.test(query)) return "exact";

  const entities = extractEntities(query);
  const tokens = tokenCount(normalized);
  const entityShare = tokens === 0 ? 0 : entities.length / tokens;

  // Rule 2: explicit wikilinks or a query dominated by entity-like
  // tokens is a proper-noun lookup.
  if (WIKILINK_RE.test(query) || entityShare >= 0.5) return "entity";

  // Rule 3: a long query with few entities reads as open-ended.
  if (tokens >= 6 && entityShare < 0.2) return "broad";

  return "neutral";
}

/**
 * Analyse a query into a deterministic plan. `expandedTerms` is empty
 * here; synonym expansion (a later layer) fills it before the hash is
 * meaningful for caching. The hash folds in the normalized query, the
 * intent, and any expanded terms - everything that changes results.
 */
export function buildQueryPlan(
  query: string,
  expandedTerms: ReadonlyArray<string> = [],
  intentOverride?: QueryIntent | null,
): QueryPlan {
  const normalized = normalize(query);
  const intent = intentOverride ?? classify(query, normalized);
  const terms = Object.freeze([...expandedTerms]);
  const planHash = fnv1a(`${normalized}|${intent}|${terms.join(",")}`);
  return Object.freeze({
    intent,
    weightProfile: PROFILES[intent],
    expandedTerms: terms,
    planHash,
  });
}
