/**
 * Embedding-provider abstraction. The store does not call into HTTP;
 * the indexer drives provider.embed() and passes raw vectors to
 * store.vecUpsert().
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §11.
 *
 * ## The construction point is where a decline is honoured
 *
 * Every embedding provider in this tree is built here, so this is the one
 * place a recorded decline can be refused BEFORE a provider exists - before
 * an endpoint is named, before a credential is read and before a byte is
 * sent. A refusal further down (at the first `embed()`) would already have
 * built the provider, which is the difference between "nothing was
 * contacted" and "something was contacted and then refused".
 *
 * The code is `EMBEDDING_DISABLED`, the same code the null provider
 * raises for the same configuration, so one condition has one code across
 * the tree; what the message adds is the DECLINE - the keys that would
 * re-enable the provider - which the null provider's message cannot know
 * and would otherwise contradict (it tells an operator who deliberately
 * wrote `embedding_provider: disabled` to go and set a provider).
 *
 * The consent is resolved by `../provider-consent.ts` and may be handed
 * in already resolved, so a caller that has read the record (the semantic
 * phase does) does not read it twice. A caller that hands in nothing gets
 * the record read from the configuration this process is pointed at.
 */

import { SearchError } from "../types.ts";
import type { ResolvedEmbeddingConfig } from "../types.ts";
import type { EmbeddingProvider } from "./contract.ts";
import {
  providerConsentIsDeclined,
  resolveProviderConsent,
  type ProviderConsent,
} from "../provider-consent.ts";

export function makeProvider(
  config: ResolvedEmbeddingConfig & { readonly configPath?: string | null },
  /**
   * The provider consent, already resolved by the caller. Absent means
   * "resolve it here", which reads the record from the configuration this
   * process is pointed at.
   */
  consent?: ProviderConsent,
): EmbeddingProvider {
  // The refusal comes FIRST, before the lazy provider imports below: a
  // declined vault must not even load the module that would have talked
  // to an endpoint.
  const resolved =
    consent ??
    resolveProviderConsent({
      ...(config.configPath !== undefined ? { configPath: config.configPath } : {}),
      semantic: config,
    });
  if (providerConsentIsDeclined(resolved)) {
    throw new SearchError("EMBEDDING_DISABLED", resolved.detail);
  }
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
