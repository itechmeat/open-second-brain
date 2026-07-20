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
 * classifier behaves identically across scripts and locales. The
 * summary-search router (t_7b96f242) obeys the same invariant: it routes on
 * structured field tokens (`source:`, `kind:`/`type:`) and a caller-supplied
 * artifact-kind vocabulary (the schema pack's page types), never a word list.
 *
 * The module is pure and deterministic: same query string in, same plan
 * out, with no I/O and no clock/random source.
 */

import { WIKILINK_DETECT_RE } from "../brain/wikilink.ts";
import { extractEntities } from "./entities.ts";
import type { QueryIntent, QueryPlan, QuerySurface, WeightProfile } from "./types.ts";

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
  exact: Object.freeze({
    keywordMul: 1.3,
    semanticMul: 0.7,
    entityMul: 1,
    recencyMul: 1,
  }),
  // Proper-noun lookup: amplify the entity layer, nudge keyword.
  entity: Object.freeze({
    keywordMul: 1.15,
    semanticMul: 0.9,
    entityMul: 1.4,
    recencyMul: 1,
  }),
  // Open-ended exploration: lean on semantic similarity and recency.
  broad: Object.freeze({
    keywordMul: 0.9,
    semanticMul: 1.2,
    entityMul: 1,
    recencyMul: 1.1,
  }),
});

const QUOTED_PHRASE_RE = /"[^"\n]{2,}"/u;
const WILDCARD_RE = /\*/u;

/**
 * Structured field-token grammar for surface routing: a `<field>:<value>`
 * token anchored at a word boundary, value running to the next whitespace.
 * Field names are a fixed structural vocabulary (never natural-language
 * words); the value is compared against the caller-supplied artifact-kind
 * vocabulary. `source:` targets a source and is vocabulary-independent.
 */
const KIND_TOKEN_RE = /(?:^|\s)(?:kind|type):(\S+)/u;
const SOURCE_TOKEN_RE = /(?:^|\s)source:\S/u;

/**
 * Route a query to a retrieval surface from structural signals only
 * (t_7b96f242). Returns `summary` when the query is source-targeted
 * (`source:<x>`) or names an artifact kind from `vocabulary`
 * (`kind:<v>` / `type:<v>` with `<v>` in the vocabulary); otherwise
 * `default`. Pure and deterministic; the vocabulary is a config-derived
 * token set (the schema pack's page types), never a word list. An empty
 * vocabulary still honours the vocabulary-independent source signal.
 */
export function routeSummarySurface(query: string, vocabulary: ReadonlySet<string>): QuerySurface {
  const normalized = query.toLowerCase();
  if (SOURCE_TOKEN_RE.test(normalized)) return "summary";
  if (vocabulary.size > 0) {
    const kindMatch = KIND_TOKEN_RE.exec(normalized);
    if (kindMatch && vocabulary.has(kindMatch[1]!)) return "summary";
  }
  return "default";
}

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
  if (WIKILINK_DETECT_RE.test(query) || entityShare >= 0.5) return "entity";

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
  surfaceVocabulary?: ReadonlySet<string>,
): QueryPlan {
  const normalized = normalize(query);
  const intent = intentOverride ?? classify(query, normalized);
  const terms = Object.freeze([...expandedTerms]);
  // Surface routing is advisory and does NOT enter the hash: it re-weights
  // nothing, so a query's cache identity and ranking stay byte-identical
  // regardless of surface. Omitting the vocabulary keeps the pure default
  // provably inert (always `default`), so existing call sites are unchanged.
  const planHash = fnv1a(`${normalized}|${intent}|${terms.join(",")}`);
  const surface =
    surfaceVocabulary === undefined ? "default" : routeSummarySurface(query, surfaceVocabulary);
  return Object.freeze({
    intent,
    weightProfile: PROFILES[intent],
    expandedTerms: terms,
    planHash,
    surface,
  });
}
