/**
 * Public types for `src/core/search/*`. Plain data — no behaviour, no I/O.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §12, §14.
 */

import type { VaultIgnoreRule } from "../vault-scope/defaults.ts";
import type { EvidencePack } from "./evidence-pack.ts";
import type { SearchSessionFocus } from "./session-focus.ts";
import type { StructuredRecallQueryDocument } from "./structured-query.ts";

export type { VaultIgnoreRule };

export const SEARCH_ERROR_CODES = [
  "INDEX_MISSING",
  "INDEX_UNREADABLE",
  "SCHEMA_MISMATCH",
  "VEC_EXTENSION_UNAVAILABLE",
  "EMBEDDING_DISABLED",
  "EMBEDDING_KEY_MISSING",
  "EMBEDDING_PROVIDER_HTTP",
  "EMBEDDING_PROVIDER_TIMEOUT",
  "EMBEDDING_DIMENSION_MISMATCH",
  "EMBEDDING_COST_GATE",
  "INDEX_LOCKED",
  "INVALID_INPUT",
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

export interface BrainSearchResult {
  readonly documentId: number;
  readonly chunkId: number;
  readonly path: string;
  readonly title: string | null;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly keywordScore: number;
  readonly semanticScore: number;
  readonly linkBoost: number;
  readonly recencyBoost: number;
  readonly searchType: "keyword" | "semantic" | "hybrid" | "link";
  /**
   * Explainable recall: one entry per scoring layer that contributed
   * to `score`, formatted `"<layer>: <fixed-precision value>"`. Layers
   * that did not fire (zero contribution) are omitted. Always present;
   * never empty for a result that surfaced.
   */
  readonly reasons: ReadonlyArray<string>;
  /**
   * Typed semantic relations this result's page declares in its
   * frontmatter (v3 / typed graph semantics): `related` / `extends` /
   * `contradicts` / `superseded_by` and any other vocabulary relation.
   * Computed at query time from the links table, never stored on the
   * result row. Absent when the page declares no typed relations.
   */
  readonly relations?: ReadonlyArray<{
    readonly relation: string;
    readonly target: string;
  }>;
  /**
   * Kind-namespaced origin label (Workspace Insight Suite, cross-vault
   * search): "local", "profile/<name>", or "source/<alias>". Only set
   * by `searchAcrossVaults`; plain single-vault search leaves it
   * absent, keeping the legacy result shape byte-identical.
   */
  readonly origin?: string;
}

/**
 * Structural query intent (v0.20.0). Derived purely from query shape -
 * quoted phrases, FTS wildcards, wikilinks, entity-token share, token
 * count - never from a natural-language word list. `neutral` trips no
 * rule and keeps ranking bit-identical.
 */
export type QueryIntent = "neutral" | "exact" | "entity" | "broad";

/**
 * Per-query ranking multipliers emitted by the query plan. Each is a
 * bounded multiplier applied to the corresponding ranking layer; the
 * neutral profile is all 1.0 (no effect).
 */
export interface WeightProfile {
  readonly keywordMul: number;
  readonly semanticMul: number;
  readonly entityMul: number;
  readonly recencyMul: number;
}

/**
 * Pure analysis of an incoming query (v0.20.0). Computed once before
 * retrieval and shared by intent-aware ranking (the `weightProfile`) and
 * candidate augmentation (`expandedTerms`, populated by synonym
 * expansion). `planHash` is a stable fingerprint of everything in the
 * plan that affects results - used as part of the query-cache key.
 */
export interface QueryPlan {
  readonly intent: QueryIntent;
  readonly weightProfile: WeightProfile;
  readonly expandedTerms: ReadonlyArray<string>;
  readonly planHash: string;
}

export interface IndexStats {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly chunksTotal: number;
  readonly embeddingsComputed: number;
  readonly embeddingsRetries: number;
  readonly errors: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
  }>;
  readonly durationMs: number;
}

/**
 * State of the optional sqlite-vec extension. `not-attempted` covers
 * the diagnostic path where we never tried to load (e.g. `check` on a
 * vault with semantic disabled); `unknown` covers status snapshots
 * taken before any open has happened (index file missing).
 */
export type VecExtensionState = "loaded" | "unavailable" | "unknown" | "not-attempted";

export interface IndexStatusSnapshot {
  readonly indexPath: string;
  readonly exists: boolean;
  readonly schemaVersion: number | null;
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  readonly staleEmbeddings: number;
  readonly embeddingModel: string | null;
  readonly embeddingDimension: number | null;
  /**
   * Canonical `<provider>:<model>:<dimension>` fingerprint of the ACTIVE
   * embedding configuration (Embedding Provider Suite). Null when
   * semantic search is disabled. Compare with the stored model/dimension
   * to reason about staleness after a config change.
   */
  readonly embeddingSignature: string | null;
  /**
   * Best-effort USD estimate to (re-)embed the chunks that currently
   * lack a current embedding, at the active model's rate. 0 for the
   * local/unknown-price case.
   */
  readonly estimatedRefreshCostUsd: number;
  readonly vecExtension: VecExtensionState;
  readonly semanticEnabled: boolean;
  readonly embeddingKeyPresent: boolean;
  readonly lastIndexedAt: string | null;
  readonly lastFullIndexAt: string | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface IndexCheckReport {
  readonly vaultReadable: boolean;
  readonly indexDirWritable: boolean;
  readonly sqliteOk: boolean;
  readonly fts5Ok: boolean;
  readonly vecExtension: VecExtensionState;
  readonly embeddingKeyResolved: boolean;
  readonly providerReachable: boolean | null;
  readonly providerReason: string | null;
  readonly warnings: ReadonlyArray<string>;
  readonly fatal: ReadonlyArray<string>;
  /**
   * Actionable hints derived from the check state — empty when
   * nothing needs operator attention. The CLI renders these under a
   * `recommendations:` block; the JSON exposes them under the same
   * key so headless callers (Hermes cron, CI) can act on them.
   */
  readonly recommendations: ReadonlyArray<string>;
}

export interface SearchOptions {
  readonly query: string;
  readonly limit?: number;
  readonly semantic?: boolean | null;
  readonly keywordOnly?: boolean;
  readonly pathPrefix?: string;
  readonly keywordWeight?: number;
  readonly semanticWeight?: number;
  /**
   * Property filter map (v0.10.17). Each key maps to one or more
   * accepted scalar values. Within one key the match is OR; across
   * keys it is AND. The filter is applied as a post-rank phase
   * against the source frontmatter of each result. Absent map = no
   * filter (existing behaviour).
   */
  readonly properties?: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * Per-query MMR override (v0.13.0). Absent uses the resolved config
   * default; `1` disables diversification for this query.
   */
  readonly mmrLambda?: number;
  /**
   * Per-query link-graph traversal depth (v0.13.0). Absent uses the
   * resolved config default; `0` disables traversal for this query.
   */
  readonly maxHops?: number;
  /**
   * Requested content-visibility scope (v3 / typed graph semantics).
   * Pages with no `visibility:` frontmatter are always returned;
   * a page that declares visibility values is returned only when this
   * scope includes one of them. Absent/empty = default scope (reaches
   * untagged pages only). See src/core/graph/visibility.ts.
   */
  readonly visibility?: ReadonlyArray<string>;
  /** Optional parsed structured recall query document. Plain-string search ignores this. */
  readonly structuredQuery?: StructuredRecallQueryDocument;
  /** Optional per-query or persisted session focus steering. Undefined means load persisted focus. */
  readonly sessionFocus?: SearchSessionFocus | null;
  /**
   * Session id for scoped focus resolution (Agent Surface Suite,
   * t_5b478e47). Applies only when `sessionFocus` is undefined: the
   * persisted focus lookup checks `search-focus/<scope>.json` first
   * and falls back to the global focus file.
   */
  readonly focusSession?: string;
  /** Opt-in verified evidence pack diagnostics. Omitted preserves the legacy search outcome shape. */
  readonly evidencePack?: boolean;
  /**
   * History mode for relation polarity (recall-trust-suite). When true a
   * matched predecessor (`superseded_by` declarer) keeps its rank and no
   * successor is pulled in; informational reasons still land. Default
   * false: stale predecessors are demoted below their successor.
   */
  readonly includeSuperseded?: boolean;
  /**
   * Time-aware recall (recall-trust-suite). Accepts ISO dates and
   * datetimes, `today` / `yesterday` / `last week` / `last month`, and
   * `<n>h` / `<n>d` / `<n>w` shorthand — see `time-range.ts`. Filters
   * candidates by document mtime before ranking. Time-filtered queries
   * bypass the query cache (a relative range resolves to a different
   * absolute window every call).
   */
  readonly since?: string;
  readonly until?: string;
  /**
   * Self-healing index policy (Workspace Insight Suite). Default true:
   * a missing or schema-stale index is rebuilt once and the search
   * retried. `searchAcrossVaults` passes false for non-active origins
   * so a read-only external vault is NEVER written to - its missing
   * index surfaces as a per-origin warning instead.
   */
  readonly selfHeal?: boolean;
}

export interface SearchOutcome {
  readonly results: ReadonlyArray<BrainSearchResult>;
  readonly warnings: ReadonlyArray<string>;
  readonly total: number;
  readonly evidencePack?: EvidencePack;
}

export interface ResolvedEmbeddingConfig {
  readonly enabled: boolean;
  readonly provider: "openai-compat" | "disabled" | "local";
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
  readonly dimension: number | null;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly batchSize: number;
  /**
   * Spend ceiling in USD for a single embedding run (Embedding Provider
   * Suite). 0 (default) disables the gate. When positive, an embedding
   * run whose estimated cost exceeds this is refused unless forced.
   */
  readonly costGateUsd: number;
}

/**
 * Recall-quality tunables (v0.13.0). Each layer is bounded and
 * deterministic; the defaults enable the layer while leaving a clear
 * off switch (`mmrLambda = 1`, `maxHops = 0`). A vault that never opts
 * out ranks by the documented defaults.
 */
export interface ResolvedRecallConfig {
  /** MMR relevance-vs-diversity tradeoff in [0, 1]; 1 disables MMR. */
  readonly mmrLambda: number;
  /** Link-graph traversal hop depth during recall; 0 disables. */
  readonly maxHops: number;
  /** Per-hop score multiplier in (0, 1]. */
  readonly hopDecay: number;
  /** Cap on outbound links followed per node. */
  readonly maxExpansionPerHit: number;
  /**
   * Weibull recency decay curve (v0.20.0). `recencyShape` is the Weibull
   * shape k (> 0); `recencyScale` is the characteristic lifetime in days
   * (> 0); `recencyAmplitude` is the maximum boost at age 0, in [0, 1].
   * Amplitude 0 disables the recency layer. See `recency.ts`.
   */
  readonly recencyShape: number;
  readonly recencyScale: number;
  readonly recencyAmplitude: number;
  /**
   * Query-intent classification (v0.20.0). When true (default) the query
   * plan's weight profile re-weights ranking per detected intent; when
   * false the neutral profile is used and ranking is bit-identical to
   * pre-intent behaviour.
   */
  readonly intentEnabled: boolean;
  /**
   * Synonym / query expansion (v0.20.0). Off by default: expansion
   * broadens the candidate set via local co-occurrence, so it changes
   * results and is opt-in. `synonymMaxTerms` caps how many expansion
   * terms are OR'd onto the query. Always suppressed for exact-intent
   * (quoted/wildcard) queries. See `synonyms.ts`.
   */
  readonly synonymEnabled: boolean;
  readonly synonymMaxTerms: number;
  /**
   * Persistent query cache (v0.20.0). Off by default: when enabled,
   * `search()` serves a previously computed result for an identical
   * request as long as the corpus generation is unchanged and the row is
   * within `cacheTtlSeconds`. A cache hit is the result that was
   * computed and stored; generation changes (embedding change or content
   * reindex) and TTL expiry invalidate it.
   */
  readonly cacheEnabled: boolean;
  readonly cacheTtlSeconds: number;
  /**
   * Relation-aware recall polarity (recall-trust-suite). When true
   * (default) typed relation edges affect ranking: `superseded_by`
   * demotes the matched predecessor and boosts/pulls in the successor,
   * `contradicts` adds warning reasons, positive relations grant a small
   * bounded boost. Vaults without typed relations rank bit-identically
   * either way; this switch exists as the explicit kill switch.
   */
  readonly relationPolarityEnabled: boolean;
  /**
   * Retrieval feedback loop (recall-trust-suite). Off by default: when
   * true, learned per-layer multipliers derived from explicit recall
   * feedback (`Brain/search/learned-weights.json`) compose with the
   * intent weight profile during ranking. Bounded, deterministic,
   * resettable — see `feedback.ts`.
   */
  readonly learnedWeightsEnabled: boolean;
}

export interface ResolvedSearchConfig {
  readonly vault: string;
  readonly dbPath: string;
  /**
   * Vault-wide exclusion rules. Resolved through
   * `src/core/vault-scope` from `<vault>/Brain/_brain.yaml` →
   * `vault.ignore_paths`; falls back to the shared built-in default
   * set when the block is not declared. The legacy
   * `search_ignore_paths` config key and the
   * `OPEN_SECOND_BRAIN_SEARCH_IGNORE` env variable were removed in
   * v0.10.9.
   */
  readonly ignoreRules: ReadonlyArray<VaultIgnoreRule>;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly keywordWeight: number;
  readonly semanticWeight: number;
  /**
   * Rank-fusion mode (Embedding Provider Suite). `linear` (default) is
   * the weighted sum of normalised BM25 and cosine; `rrf` fuses the two
   * lanes by reciprocal rank. `linear` keeps ranking bit-identical to
   * pre-suite behaviour.
   */
  readonly fusionMode: "linear" | "rrf";
  /** Reciprocal Rank Fusion damping constant (only used when rrf). */
  readonly rrfK: number;
  readonly semantic: ResolvedEmbeddingConfig;
  readonly recall: ResolvedRecallConfig;
}
