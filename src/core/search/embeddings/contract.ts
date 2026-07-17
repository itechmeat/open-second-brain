/**
 * Embedding-provider contract. The interface every embedding provider
 * implements, split out from the factory (`provider.ts`) so implementations
 * depend only on this leaf and never on the module that constructs them.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §11.
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimension: number | null;
  embed(texts: ReadonlyArray<string>): Promise<number[][]>;
  ping(): Promise<{ ok: true; dimension: number } | { ok: false; reason: string }>;
  /**
   * Optional read-and-reset of provider-internal retry tally. The
   * indexer consumes this after each `embed()` to populate
   * `IndexStats.embeddingsRetries`. Providers that never retry
   * (NullProvider, MockEmbeddingProvider) leave this undefined.
   */
  consumeRetryCount?(): number;
}
