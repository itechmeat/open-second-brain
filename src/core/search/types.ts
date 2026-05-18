/**
 * Public types for `src/core/search/*`. Plain data — no behaviour, no I/O.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §12, §14.
 */

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
  readonly searchType: "keyword" | "semantic" | "hybrid";
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

export interface ResolvedSearchConfig {
  readonly vault: string;
  readonly dbPath: string;
  readonly ignorePaths: ReadonlyArray<string>;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly keywordWeight: number;
  readonly semanticWeight: number;
  readonly semantic: ResolvedEmbeddingConfig;
}
