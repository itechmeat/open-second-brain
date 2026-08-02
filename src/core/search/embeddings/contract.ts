/**
 * Embedding-provider contract. The interface every embedding provider
 * implements, split out from the factory (`provider.ts`) so implementations
 * depend only on this leaf and never on the module that constructs them.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §11.
 */

/**
 * Instruction-prefix kind for an embed call (memory-write-path-integrity B2).
 * Asymmetric-instruction embedding families (e5) expect a different lead-in
 * for a search query versus an indexed passage. The kind is optional and
 * additive: a provider that ignores it, or a call that omits it, embeds the
 * raw text unchanged.
 */
export type EmbedKind = "query" | "passage";

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimension: number | null;
  embed(texts: ReadonlyArray<string>, kind?: EmbedKind): Promise<number[][]>;
  ping(): Promise<{ ok: true; dimension: number } | { ok: false; reason: string }>;
  /**
   * Optional read-and-reset of provider-internal retry tally. The
   * indexer consumes this after each `embed()` to populate
   * `IndexStats.embeddingsRetries`. Providers that never retry
   * (NullProvider, MockEmbeddingProvider) leave this undefined.
   */
  consumeRetryCount?(): number;
  /**
   * Whether this provider produces vectors at all
   * (provenance-at-the-boundary, F2). Read through
   * {@link providerProducesVectors}, never directly.
   *
   * Four call sites used to answer this by comparing `name` to the
   * literal `"null"`, so any provider registered under a different name
   * bypassed all four silently. The question belongs to the contract, so
   * the contract answers it.
   *
   * Optional and additive, in the same shape as `consumeRetryCount`
   * above. An absent declaration means "produces vectors", which is the
   * truthful default for every implementation that is a real embedder -
   * it is not a fallback covering a failure, because there is no failure
   * here to cover: a provider that CANNOT embed is a configuration
   * sentinel, and a sentinel is written knowing it is one.
   */
  readonly producesVectors?: boolean;
}

/**
 * True when `provider` embeds text. The single predicate every site that
 * needs to tell a real provider from the configuration sentinel calls -
 * `resolveConfiguredEmbeddingProvider`, the hygiene dedup detector, and
 * the readiness probe.
 */
export function providerProducesVectors(provider: EmbeddingProvider): boolean {
  return provider.producesVectors ?? true;
}
