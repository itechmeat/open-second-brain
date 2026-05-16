/**
 * Public search query: orchestrates FTS5, semantic vector search, link
 * + recency boosts, and the keyword-only fallback policy.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §7, §9.
 *
 * The function is async because semantic search requires an HTTP call
 * (the provider embeds the query). Keyword-only paths stay sync inside
 * the store but the public surface stays uniform.
 */

import { makeProvider } from "./embeddings/provider.ts";
import { runFtsQuery } from "./fts.ts";
import { rankResults } from "./ranker.ts";
import { Store } from "./store.ts";
import { SearchError } from "./types.ts";
import type {
  BrainSearchResult,
  ResolvedSearchConfig,
  SearchOptions,
  SearchOutcome,
} from "./types.ts";

interface SemanticPolicy {
  /** caller asked for semantic on or off (true), or accepted the default (false). */
  readonly explicit: boolean;
  /** does the caller want semantic at all? */
  readonly wantSemantic: boolean;
}

function resolveSemanticPolicy(
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

function assertSafePathPrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  if (prefix.includes("..") || prefix.startsWith("/")) {
    throw new SearchError("INVALID_INPUT", "path_prefix escapes vault");
  }
  return prefix;
}

export async function search(
  config: ResolvedSearchConfig,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  const query = (opts.query ?? "").trim();
  if (!query) {
    throw new SearchError("INVALID_INPUT", "missing required argument: query");
  }
  const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
  const pathPrefix = assertSafePathPrefix(opts.pathPrefix);
  const policy = resolveSemanticPolicy(config, opts);
  const warnings: string[] = [];

  const store = await Store.open(config, { mode: "read" });
  try {
    // Keyword candidates.
    const kwHits = runFtsQuery(store, query, {
      limit: limit * 3,
      pathPrefix,
    });

    // Semantic candidates (may be skipped).
    let semHits: ReturnType<Store["semanticTopK"]> = [];
    let semanticAttempted = false;
    if (policy.wantSemantic) {
      const semOutcome = await runSemanticPhase(store, config, query, {
        limit: Math.max(limit * 5, 50),
        pathPrefix,
        explicit: policy.explicit,
      });
      semanticAttempted = semOutcome.attempted;
      semHits = semOutcome.hits;
      for (const w of semOutcome.warnings) warnings.push(w);
    }

    // Hydrate.
    const allChunkIds = new Set<number>();
    for (const h of kwHits) allChunkIds.add(h.chunkId);
    for (const h of semHits) allChunkIds.add(h.chunkId);
    const idsList = Array.from(allChunkIds);
    if (idsList.length === 0) {
      return Object.freeze({
        results: Object.freeze([] as ReadonlyArray<BrainSearchResult>),
        warnings: Object.freeze(warnings),
        total: 0,
      });
    }

    const hydrated = store.hydrateChunks(idsList);
    const inboundLinkSources = store.inboundLinkSources(idsList);
    const tagsByDoc = store.tagsByChunkDocument(idsList);

    const ranked = rankResults(
      {
        keyword: kwHits,
        semantic: semHits,
        hydrated,
        inboundLinkSources,
        tagsByDoc,
      },
      {
        keywordWeight: opts.keywordWeight ?? config.keywordWeight,
        semanticWeight: opts.semanticWeight ?? config.semanticWeight,
        limit,
        semanticEnabled: policy.wantSemantic && semanticAttempted,
      },
    );

    return Object.freeze({
      results: Object.freeze(ranked),
      warnings: Object.freeze(warnings),
      total: ranked.length,
    });
  } finally {
    await store.close();
  }
}

interface SemanticPhaseOutcome {
  readonly attempted: boolean;
  readonly hits: ReturnType<Store["semanticTopK"]>;
  readonly warnings: string[];
}

async function runSemanticPhase(
  store: Store,
  config: ResolvedSearchConfig,
  query: string,
  opts: { limit: number; pathPrefix: string | undefined; explicit: boolean },
): Promise<SemanticPhaseOutcome> {
  const warnings: string[] = [];

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
  if (!config.semantic.apiKey) {
    if (opts.explicit) {
      throw new SearchError("EMBEDDING_KEY_MISSING", "embedding key not configured");
    }
    warnings.push("embedding key not configured; semantic disabled");
    return { attempted: false, hits: [], warnings };
  }

  // Data-state check: are there embeddings to search against at all?
  const counts = store.counts();
  if (counts.embeddings === 0) {
    warnings.push("no compatible embeddings; run: o2b search index --embeddings");
    return { attempted: false, hits: [], warnings };
  }

  let queryVec: number[];
  try {
    const provider = makeProvider(config.semantic);
    const vectors = await provider.embed([query]);
    queryVec = vectors[0] ?? [];
  } catch (e) {
    if (opts.explicit) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`embedding provider unavailable: ${msg}`);
    return { attempted: false, hits: [], warnings };
  }

  if (queryVec.length === 0) {
    warnings.push("embedding provider returned an empty vector; semantic skipped");
    return { attempted: false, hits: [], warnings };
  }

  const hits = store.semanticTopK(queryVec, { limit: opts.limit, pathPrefix: opts.pathPrefix });
  return { attempted: true, hits, warnings };
}
