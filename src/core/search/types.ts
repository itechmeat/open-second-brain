/**
 * Public types for `src/core/search/*`. Plain data — no behaviour, no I/O.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §12, §14.
 */

import type { VaultIgnoreRule } from "../vault-scope/defaults.ts";

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
}

export interface IndexStats {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly chunksTotal: number;
  readonly embeddingsComputed: number;
  readonly embeddingsRetries: number;
  readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>;
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
}

export interface SearchOutcome {
  readonly results: ReadonlyArray<BrainSearchResult>;
  readonly warnings: ReadonlyArray<string>;
  readonly total: number;
}

export interface ResolvedEmbeddingConfig {
  readonly enabled: boolean;
  readonly provider: "openai-compat" | "disabled";
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
  readonly dimension: number | null;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly batchSize: number;
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
  readonly semantic: ResolvedEmbeddingConfig;
  readonly recall: ResolvedRecallConfig;
}
