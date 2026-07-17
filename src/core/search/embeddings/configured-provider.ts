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
import type { EmbeddingProvider } from "./contract.ts";

/**
 * Resolve the vault's configured embedding provider. Returns `null` when
 * semantic search is disabled (the null provider) or when resolution
 * throws — callers then fall back to a deterministic path rather than
 * failing. Mirrors the inline guard in the hygiene dedup detector.
 */
export function resolveConfiguredEmbeddingProvider(
  vault: string,
  opts: { readonly configPath?: string } = {},
): EmbeddingProvider | null {
  try {
    const configPath = opts.configPath ?? discoverConfig().path;
    const provider = makeProvider(resolveSearchConfig({ vault, configPath }).semantic);
    return provider.name === "null" ? null : provider;
  } catch {
    return null;
  }
}
