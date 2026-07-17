/**
 * Cross-encoder rerank contract (retrieval-precision-quality-loop,
 * card A / t_110867f5).
 *
 * The interface every rerank provider implements, split out from the
 * factory (`provider.ts`) so implementations depend only on this leaf and
 * never on the module that constructs them. A rerank provider jointly
 * re-scores a query against a set of candidate documents and returns one
 * relevance score per document, aligned to the input order.
 */

export interface RerankProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Score each document's relevance to the query. Returns an array of the
   * same length as `documents`, aligned by index. Higher is more relevant.
   * Throws on any provider/transport failure — the caller
   * ({@link applyCrossEncoderRerank}) is responsible for the fail-open.
   */
  rerank(query: string, documents: ReadonlyArray<string>): Promise<number[]>;
}
