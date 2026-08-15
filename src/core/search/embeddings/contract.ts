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

/**
 * What a `ping` learned when it did not get a vector back.
 *
 * `timedOut` is set ONLY when the provider attributes the failure to its
 * own request budget elapsing rather than to an answer it received. Absent
 * means the provider makes no such claim - which is not a claim that it
 * did not time out, and readers must treat it as "not stated" rather than
 * as "false". It is optional and additive, in the same shape as
 * {@link EmbeddingProvider.consumeRetryCount}: a provider that cannot tell
 * the two apart keeps returning exactly what it returned before.
 *
 * The distinction is load-bearing for the `o2b search check` pre-flight
 * (wiring-what-exists, E1): a provider that answered and refused is a
 * fault, while a provider that never answered is a measurement that did
 * not complete, and the two must not share an exit code.
 */
export interface PingFailure {
  readonly ok: false;
  readonly reason: string;
  readonly timedOut?: boolean;
}

export type PingResult = { readonly ok: true; readonly dimension: number } | PingFailure;

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimension: number | null;
  embed(texts: ReadonlyArray<string>, kind?: EmbedKind): Promise<number[][]>;
  ping(): Promise<PingResult>;
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
