/**
 * Configured-provider resolution (semantic-retrieval-precision, parent
 * t_47fd9523).
 *
 * Resolves the vault's configured embedding provider through the full
 * `resolveSearchConfig` path. Split out from `provider-resolve.ts` so that
 * the low-level endpoint seam stays free of a dependency on the search
 * config barrel (`index.ts`); this module is the one that carries it.
 */

import { discoverConfig } from "../../config.ts";
import { resolveSearchConfig } from "../index.ts";
import { makeProvider } from "./provider.ts";
import { providerProducesVectors } from "./contract.ts";
import type { EmbeddingProvider } from "./contract.ts";

/**
 * Resolve the vault's configured embedding provider. Returns `null` when
 * semantic search is disabled (the sentinel provider) or when resolution
 * throws — callers then fall back to a deterministic path rather than
 * failing. Mirrors the inline guard in the hygiene dedup detector.
 *
 * The sentinel is recognised by the contract predicate, not by its name
 * (provenance-at-the-boundary, F2): a provider registered under any other
 * name used to slip past this guard and be handed to a caller that then
 * called `embed()` on it.
 */
export function resolveConfiguredEmbeddingProvider(
  vault: string,
  opts: { readonly configPath?: string } = {},
): EmbeddingProvider | null {
  try {
    const configPath = opts.configPath ?? discoverConfig().path;
    const provider = makeProvider(resolveSearchConfig({ vault, configPath }).semantic);
    return providerProducesVectors(provider) ? provider : null;
  } catch {
    return null;
  }
}
