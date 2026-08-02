/**
 * Sentinel embedding provider that surfaces configuration bugs.
 *
 * `embed()` throwing is intentional — a caller that reaches this path
 * has set semantic on the call but the runtime has no provider wired
 * up. Better to fail loud than to silently no-op and persist no
 * vectors.
 */

import { SearchError } from "../types.ts";
import type { EmbeddingProvider } from "./contract.ts";

export class NullProvider implements EmbeddingProvider {
  readonly name = "null";
  readonly model = "";
  readonly dimension = null;
  /**
   * The one implementation in the tree that embeds nothing, and the
   * reason the contract carries this flag at all
   * (provenance-at-the-boundary, F2). Callers ask
   * `providerProducesVectors(provider)`, never `provider.name === "null"`.
   */
  readonly producesVectors = false;

  embed(_texts: ReadonlyArray<string>): Promise<number[][]> {
    return Promise.reject(
      new SearchError(
        "EMBEDDING_DISABLED",
        "embeddings disabled: no provider configured. Set embedding_provider, embedding_base_url, embedding_model, embedding_api_key.",
      ),
    );
  }

  async ping(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: "embeddings disabled" };
  }
}
