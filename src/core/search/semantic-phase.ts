/**
 * Semantic candidate lane: the on/off policy the caller's options resolve
 * to, the candidate-pool over-fetch sizing, and the guarded semantic
 * phase that embeds the query and runs the vector top-K (self-degrading
 * to keyword-only with warnings when the lane cannot run).
 */

import { classifyEmbeddingError } from "./embeddings/openai-compat.ts";
import { makeProvider } from "./embeddings/provider.ts";
import { Store } from "./store.ts";
import { EMBEDDING_QUOTA_MESSAGE, SearchError } from "./types.ts";
import type { ResolvedSearchConfig, SearchOptions } from "./types.ts";

export interface SemanticPolicy {
  /** caller asked for semantic on or off (true), or accepted the default (false). */
  readonly explicit: boolean;
  /** does the caller want semantic at all? */
  readonly wantSemantic: boolean;
}

export function resolveSemanticPolicy(
  config: ResolvedSearchConfig,
  opts: SearchOptions,
): SemanticPolicy {
  if (opts.keywordOnly === true) {
    return { explicit: true, wantSemantic: false };
  }
  if (opts.semantic === true) return { explicit: true, wantSemantic: true };
  if (opts.semantic === false) return { explicit: true, wantSemantic: false };
  return { explicit: false, wantSemantic: config.semantic.enabled };
}

/**
 * Semantic candidate-pool over-fetch policy: rank more than `limit` rows
 * so downstream filtering (property/visibility scope, MMR diversify) has
 * enough headroom to still fill the final window. `floor` is the minimum
 * pool size regardless of `limit`; `overfetch` is the multiplier applied
 * to `limit` itself.
 */
const POOL_OVERFETCH = 5;
const POOL_FLOOR = 50;

export function semanticPoolSize(limit: number): number {
  return Math.max(limit * POOL_OVERFETCH, POOL_FLOOR);
}

interface SemanticPhaseOutcome {
  readonly attempted: boolean;
  readonly hits: ReturnType<Store["semanticTopK"]>;
  readonly warnings: string[];
}

export async function runSemanticPhase(
  store: Store,
  config: ResolvedSearchConfig,
  query: string,
  opts: { limit: number; pathPrefix: string | undefined; explicit: boolean },
): Promise<SemanticPhaseOutcome> {
  const warnings: string[] = [];

  const counts = store.counts();
  if (counts.embeddings === 0) {
    warnings.push("no compatible embeddings; run: o2b search index --embeddings");
    return { attempted: false, hits: [], warnings };
  }

  if (!store.vecLoaded()) {
    if (opts.explicit) {
      throw new SearchError(
        "VEC_EXTENSION_UNAVAILABLE",
        "semantic search unavailable: sqlite-vec extension not loaded",
      );
    }
    warnings.push("sqlite-vec unavailable, semantic disabled this session");
    return { attempted: false, hits: [], warnings };
  }
  if (!config.semantic.enabled) {
    // Defensive: should be handled at policy layer, but in case caller
    // forced wantSemantic without enabling, treat as implicit warning.
    warnings.push("semantic not enabled in config; using keyword-only");
    return { attempted: false, hits: [], warnings };
  }
  // The offline local provider needs no key; every remote provider does.
  if (config.semantic.provider !== "local" && !config.semantic.apiKey) {
    if (opts.explicit) {
      throw new SearchError("EMBEDDING_KEY_MISSING", "embedding key not configured");
    }
    warnings.push("embedding key not configured; semantic disabled");
    return { attempted: false, hits: [], warnings };
  }

  let queryVec: number[];
  try {
    const provider = makeProvider(config.semantic);
    const vectors = await provider.embed([query], "query");
    queryVec = vectors[0] ?? [];
  } catch (e) {
    if (opts.explicit) {
      // Defensive: provider methods are expected to throw SearchError,
      // but wrap anything else (e.g. an unexpected runtime failure)
      // so callers always see a typed code rather than a bare Error.
      if (e instanceof SearchError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new SearchError("EMBEDDING_PROVIDER_HTTP", `embedding provider failure: ${msg}`);
    }
    // Implicit path: degrade to keyword-only, but the warning must say WHY
    // by naming the classification category, and for a quota exhaustion it
    // carries the actionable billing message so the CLI/MCP caller learns
    // the remediation, not just that semantic was skipped.
    const cls = classifyEmbeddingError(e);
    const detail =
      cls.category === "quota"
        ? EMBEDDING_QUOTA_MESSAGE
        : e instanceof Error
          ? e.message
          : String(e);
    warnings.push(`embedding provider unavailable [${cls.category}]: ${detail}`);
    return { attempted: false, hits: [], warnings };
  }

  if (queryVec.length === 0) {
    warnings.push("embedding provider returned an empty vector; semantic skipped");
    return { attempted: false, hits: [], warnings };
  }

  const hits = store.semanticTopK(queryVec, {
    limit: opts.limit,
    pathPrefix: opts.pathPrefix,
  });
  return { attempted: true, hits, warnings };
}
