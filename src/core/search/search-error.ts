/**
 * The typed failure vocabulary of `src/core/search/*`: the error-code
 * union, the {@link SearchError} carrier, and the embedding-provider
 * error taxonomy.
 *
 * A LEAF by construction — it imports nothing from the search layer. The
 * parsers that raise (`time-range.ts`, `temporal-intent.ts`,
 * `property-filter.ts`) are themselves leaves that `types.ts` aggregates
 * from, so an error carrier living in the aggregate would make every
 * raising parser point back at it.
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
  "EMBEDDING_INVALID_VECTOR",
  "EMBEDDING_COST_GATE",
  "EMBEDDING_QUOTA_EXHAUSTED",
  "RERANK_PROVIDER_HTTP",
  "INDEX_LOCKED",
  "INVALID_INPUT",
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

/**
 * Actionable operator-facing message for an exhausted embedding quota /
 * billing limit (Task C1/C2). Shared by the provider (thrown message), the
 * semantic-phase degrade warning, and the MCP error mapping so the single
 * remediation instruction stays consistent across every surface.
 */
export const EMBEDDING_QUOTA_MESSAGE =
  "embedding quota/billing exhausted: semantic search is degraded to keyword-only. " +
  "Check your embedding provider billing and quota, raise the limit or top up, then reindex.";

/**
 * Coarse outcome category for an embedding-provider error (Task C1). Drives
 * both the retry policy (`retriable`) and the degrade-warning wording.
 * `quota` and `auth` fail fast; `rate_limit` and `transient` retry.
 */
export type EmbeddingErrorCategory = "quota" | "rate_limit" | "auth" | "transient" | "fatal";

/**
 * Additive structured context for a {@link SearchError} originating from a
 * provider HTTP response. Both fields are optional so every existing
 * two-argument call site stays valid.
 */
export interface SearchErrorOptions {
  /** Upstream HTTP status code. */
  readonly status?: number;
  /** Parsed `Retry-After` delay in milliseconds. */
  readonly retryAfterMs?: number;
}

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  /** Upstream HTTP status when this error originated from a provider response. */
  readonly status?: number;
  /** Parsed `Retry-After` delay in milliseconds when the provider supplied one. */
  readonly retryAfterMs?: number;
  constructor(code: SearchErrorCode, message: string, opts?: SearchErrorOptions) {
    super(message);
    this.name = "SearchError";
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}
