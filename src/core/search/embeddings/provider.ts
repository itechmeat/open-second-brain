/**
 * Embedding-provider abstraction. The store does not call into HTTP;
 * the indexer drives provider.embed() and passes raw vectors to
 * store.vecUpsert().
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §11.
 */

import { SearchError } from "../types.ts";
import type { ResolvedEmbeddingConfig } from "../types.ts";
import type { EmbeddingProvider } from "./contract.ts";

export function makeProvider(config: ResolvedEmbeddingConfig): EmbeddingProvider {
  // Lazy imports to keep the module graph small for users who never
  // enable semantic search.
  if (config.provider === "disabled" || !config.enabled) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NullProvider } = require("./null-provider.ts") as typeof import("./null-provider.ts");
    return new NullProvider();
  }
  if (config.provider === "local") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalProvider, LOCAL_DEFAULT_DIMENSION } =
      require("./local-provider.ts") as typeof import("./local-provider.ts");
    return new LocalProvider(config.dimension ?? LOCAL_DEFAULT_DIMENSION);
  }
  if (config.provider === "openai-compat") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OpenAICompatProvider } =
      require("./openai-compat.ts") as typeof import("./openai-compat.ts");
    return new OpenAICompatProvider(config);
  }
  if (config.provider === "zeroentropy") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ZeroEntropyProvider } =
      require("./zeroentropy.ts") as typeof import("./zeroentropy.ts");
    return new ZeroEntropyProvider(config);
  }
  throw new SearchError(
    "INVALID_INPUT",
    `unknown embedding_provider '${String((config as { provider?: string }).provider)}'`,
  );
}
