/**
 * Embedding-provider abstraction. The store does not call into HTTP;
 * the indexer drives provider.embed() and passes raw vectors to
 * store.vecUpsert().
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §11.
 */

import { SearchError } from "../types.ts";
import type { ResolvedEmbeddingConfig } from "../types.ts";

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

export function makeProvider(config: ResolvedEmbeddingConfig): EmbeddingProvider {
  // Lazy imports to keep the module graph small for users who never
  // enable semantic search.
  if (config.provider === "disabled" || !config.enabled) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NullProvider } = require("./null-provider.ts") as typeof import("./null-provider.ts");
    return new NullProvider();
  }
  if (config.provider === "openai-compat") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OpenAICompatProvider } = require("./openai-compat.ts") as typeof import("./openai-compat.ts");
    return new OpenAICompatProvider(config);
  }
  throw new SearchError(
    "INVALID_INPUT",
    `unknown embedding_provider '${String((config as { provider?: string }).provider)}'`,
  );
}
