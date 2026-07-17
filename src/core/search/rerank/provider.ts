/**
 * Cross-encoder rerank provider abstraction (retrieval-precision-quality-loop,
 * card A / t_110867f5).
 *
 * A rerank provider jointly re-scores a query against a set of candidate
 * documents and returns one relevance score per document, aligned to the
 * input order. Unlike the embedding provider (which vectorises text for
 * the index), a rerank provider is a READ-TIME final reader step: it takes
 * the already-fused, heuristically-ranked top-K candidates and produces a
 * learned re-scoring the deterministic core cannot.
 *
 * The interface is intentionally minimal so a test can inject a
 * deterministic stub without any HTTP, and so alternate learned rerankers
 * (a local model, a different endpoint shape) can implement it later.
 *
 * Mirrors `embeddings/provider.ts`'s discipline: the module graph stays
 * small (the OpenAI-compatible implementation is imported lazily by the
 * factory) so a vault that never enables rerank pays nothing.
 */

import type { OpenAiCompatEndpoint } from "../embeddings/provider-resolve.ts";
import type { RerankProvider } from "./contract.ts";

/**
 * Build the default OpenAI-compatible cross-encoder rerank provider for a
 * resolved endpoint. Lazily imported so the cross-encoder HTTP module is
 * only loaded when rerank is actually enabled and configured.
 */
export function makeRerankProvider(
  endpoint: OpenAiCompatEndpoint,
  opts?: { readonly timeoutMs?: number },
): RerankProvider {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CrossEncoderRerankProvider } =
    require("./cross-encoder.ts") as typeof import("./cross-encoder.ts");
  return new CrossEncoderRerankProvider(endpoint, opts);
}
