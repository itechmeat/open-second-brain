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

import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { isVisible, normalizeVisibilityScope, pageVisibility } from "../graph/visibility.ts";
import { makeProvider } from "./embeddings/provider.ts";
import { extractEntities } from "./entities.ts";
import { buildEvidencePack, downrankTerminalEvidenceResults } from "./evidence-pack.ts";
import { runFtsQueryDetailed } from "./fts.ts";
import { mmrRerank } from "./mmr.ts";
import { buildQueryPlan } from "./query-plan.ts";
import { buildCacheKey, getCachedOutcome, putCachedOutcome } from "./query-cache.ts";
import { deriveExpansionTerms, tokenizeForExpansion, DEFAULT_EXPANSION } from "./synonyms.ts";
import { filterByProperties } from "./property-filter.ts";
import { rankResults } from "./ranker.ts";
import { readSessionFocus } from "./session-focus.ts";
import { expandByTraversal, type TraversalOptions } from "./traversal.ts";
import { Store } from "./store.ts";
import { SearchError } from "./types.ts";
import type {
  BrainSearchResult,
  ResolvedSearchConfig,
  SearchOptions,
  SearchOutcome,
} from "./types.ts";
import type { StructuredRecallQueryDocument } from "./structured-query.ts";

interface SemanticPolicy {
  /** caller asked for semantic on or off (true), or accepted the default (false). */
  readonly explicit: boolean;
  /** does the caller want semantic at all? */
  readonly wantSemantic: boolean;
}

function resolveSemanticPolicy(config: ResolvedSearchConfig, opts: SearchOptions): SemanticPolicy {
  if (opts.keywordOnly === true) {
    return { explicit: true, wantSemantic: false };
  }
  if (opts.semantic === true) return { explicit: true, wantSemantic: true };
  if (opts.semantic === false) return { explicit: true, wantSemantic: false };
  return { explicit: false, wantSemantic: config.semantic.enabled };
}

/**
 * A compact fingerprint of the resolved-config fields that change search
 * results, folded into the cache key so a config change (weights,
 * semantic toggle, recall tunables) invalidates cached rows alongside the
 * corpus generation. Cache-only knobs (enable/TTL) are excluded - they do
 * not change result content.
 */
function configFingerprint(config: ResolvedSearchConfig): string {
  const r = config.recall;
  return JSON.stringify({
    kw: config.keywordWeight,
    sw: config.semanticWeight,
    sem: config.semantic.enabled,
    mmr: r.mmrLambda,
    hops: r.maxHops,
    hopDecay: r.hopDecay,
    maxExp: r.maxExpansionPerHit,
    rShape: r.recencyShape,
    rScale: r.recencyScale,
    rAmp: r.recencyAmplitude,
    intent: r.intentEnabled,
    syn: r.synonymEnabled,
    synMax: r.synonymMaxTerms,
  });
}

function assertSafePathPrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  if (prefix.includes("..") || prefix.startsWith("/")) {
    throw new SearchError("INVALID_INPUT", "path_prefix escapes vault");
  }
  return prefix;
}

function structuredKeywordQuery(
  query: string,
  structured: StructuredRecallQueryDocument | undefined,
): string {
  if (!structured || structured.lex.include.length === 0) return query;
  return structured.lex.include.join(" ");
}

function structuredSemanticQuery(
  structured: StructuredRecallQueryDocument | undefined,
): string | null {
  if (!structured) return null;
  const text = [...structured.vec, ...structured.hyde].join("\n\n").trim();
  return text.length > 0 ? text : null;
}

function includesFolded(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function applyStructuredExclusions(
  results: ReadonlyArray<BrainSearchResult>,
  structured: StructuredRecallQueryDocument | undefined,
): ReadonlyArray<BrainSearchResult> {
  if (!structured || structured.lex.exclude.length === 0) return results;
  return results.filter((result) => {
    const haystack = `${result.path}\n${result.title ?? ""}\n${result.content}`;
    return !structured.lex.exclude.some((term) => includesFolded(haystack, term));
  });
}

function addStructuredReasons(
  results: ReadonlyArray<BrainSearchResult>,
  structured: StructuredRecallQueryDocument | undefined,
): ReadonlyArray<BrainSearchResult> {
  if (!structured) return results;
  return results.map((result) => {
    const additions: string[] = [];
    if (structured.lex.include.length > 0 && result.keywordScore > 0) {
      additions.push(`lane:lex/fts5 ${result.keywordScore.toFixed(3)}`);
    }
    if (structured.vec.length > 0 && result.semanticScore > 0) {
      additions.push(`lane:vec/semantic ${result.semanticScore.toFixed(3)}`);
    }
    if (structured.hyde.length > 0 && result.semanticScore > 0) {
      additions.push(`lane:hyde/semantic ${result.semanticScore.toFixed(3)}`);
    }
    if (structured.intent !== null) additions.push(`intent:${structured.intent}`);
    if (additions.length === 0) return result;
    return Object.freeze({
      ...result,
      reasons: Object.freeze([...result.reasons, ...additions]),
    });
  });
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
  const structured = opts.structuredQuery;
  const sessionFocus =
    opts.sessionFocus === undefined ? readSessionFocus(config, Date.now()) : opts.sessionFocus;
  const keywordQuery = structuredKeywordQuery(query, structured);
  const semanticLaneQuery = structuredSemanticQuery(structured);

  // Query plan (v0.20.0): one structural pass yields the intent weight
  // profile and the cache key. Pure; no I/O. Expanded terms (if any) are
  // folded in once they have been derived from the store below.
  const basePlan = buildQueryPlan(keywordQuery, [], structured?.intent);

  const store = await Store.open(config, { mode: "read" });
  try {
    // Persistent query cache (v0.20.0): opt-in. Keyed by the request +
    // base plan hash + a config fingerprint, gated by the corpus
    // generation and a TTL. A hit returns the previously computed
    // outcome; generation changes (embedding change or content reindex)
    // and TTL expiry invalidate it. Expansion terms are not in the key:
    // they are determined by (query, index content) and any content
    // change bumps the generation. The cache write is best-effort.
    const cacheEnabled = config.recall.cacheEnabled;
    const ttlMs = config.recall.cacheTtlSeconds * 1000;
    let cacheKey: string | null = null;
    let generation = "";
    if (cacheEnabled) {
      // The whole cache lookup is best-effort: any failure (e.g. a
      // SQLITE_BUSY past the busy_timeout under a concurrent reindex)
      // falls through to a normal fresh compute rather than breaking the
      // search. Key on the EFFECTIVE request (clamped limit, resolved
      // semantic decision) so equivalent calls share a cache entry.
      try {
        generation = store.corpusGeneration();
        const keyOpts = {
          ...opts,
          limit,
          semantic: policy.wantSemantic,
          keywordOnly: false,
          sessionFocus,
        };
        cacheKey = buildCacheKey(keyOpts, basePlan.planHash, configFingerprint(config));
        const hit = getCachedOutcome(store, cacheKey, generation, ttlMs, Date.now());
        if (hit) return hit;
      } catch {
        cacheKey = null;
      }
    }
    const finalize = (outcome: SearchOutcome): SearchOutcome => {
      if (cacheEnabled && cacheKey) {
        try {
          store.queryCacheSweep(generation, Date.now() - ttlMs);
          putCachedOutcome(store, cacheKey, generation, outcome, Date.now());
        } catch {
          // Cache persistence is best-effort; never fail a search on it.
        }
      }
      return outcome;
    };

    // Keyword candidates.
    let kwOutcome = runFtsQueryDetailed(store, keywordQuery, {
      limit: limit * 3,
      pathPrefix,
    });
    let kwHits = kwOutcome.hits;
    for (const w of kwOutcome.warnings) warnings.push(w);

    // Synonym / query expansion (v0.20.0): opt-in and never for an
    // exact-intent (quoted/wildcard) query. Derive related terms from
    // the top candidates' own content (local co-occurrence) and re-run
    // FTS with them OR'd onto the original query to broaden recall. A
    // no-op - byte-identical kwHits - when disabled or no term qualifies.
    let plan = basePlan;
    if (config.recall.synonymEnabled && basePlan.intent !== "exact" && kwHits.length > 0) {
      const topIds = kwHits.slice(0, 10).map((h) => h.chunkId);
      const ctx = store.hydrateChunks(topIds);
      const texts = topIds.map((id) => ctx.get(id)?.content ?? "").filter((t) => t.length > 0);
      const expandedTerms = deriveExpansionTerms(tokenizeForExpansion(query), texts, {
        ...DEFAULT_EXPANSION,
        maxTerms: config.recall.synonymMaxTerms,
      });
      if (expandedTerms.length > 0) {
        plan = buildQueryPlan(keywordQuery, expandedTerms, structured?.intent);
        kwOutcome = runFtsQueryDetailed(store, keywordQuery, {
          limit: limit * 3,
          pathPrefix,
          expandedTerms,
        });
        kwHits = kwOutcome.hits;
        for (const w of kwOutcome.warnings) warnings.push(w);
      }
    }
    const weightProfile = config.recall.intentEnabled ? plan.weightProfile : undefined;

    // Semantic candidates (may be skipped).
    let semHits: ReturnType<Store["semanticTopK"]> = [];
    let semanticAttempted = false;
    if (semanticLaneQuery !== null && !policy.wantSemantic) {
      warnings.push("semantic structured lanes skipped: semantic search is disabled");
    }
    if (policy.wantSemantic) {
      const semOutcome = await runSemanticPhase(store, config, semanticLaneQuery ?? query, {
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
      const evidencePack = opts.evidencePack === true ? buildEvidencePack(query, []) : undefined;
      return finalize(
        Object.freeze({
          results: Object.freeze([] as ReadonlyArray<BrainSearchResult>),
          warnings: Object.freeze(warnings),
          total: 0,
          ...(evidencePack !== undefined ? { evidencePack } : {}),
        }),
      );
    }

    const hydrated = store.hydrateChunks(idsList);
    const inboundLinkSources = store.inboundLinkSources(idsList);
    const tagsByDoc = store.tagsByChunkDocument(idsList);

    // Entity-boosted retrieval (v0.13.0): extract entities from the
    // query and count overlaps with each candidate chunk. Empty when the
    // query names no entities or the index predates the entity store.
    const queryEntities = extractEntities(query);
    const entityMatchByChunk =
      queryEntities.length > 0 ? store.chunkEntityMatches(idsList, queryEntities) : undefined;

    // When a property filter is active, overfetch the ranked
    // candidates so the post-filter result set still has a chance
    // of producing `limit` matching rows. Without this, the
    // top-`limit` ranked hits can lose all their property-matching
    // candidates to the filter and surface zero results even when
    // matches exist deeper in the rank.
    const hasPropertyFilter = opts.properties !== undefined && opts.properties.size > 0;
    // An explicit visibility scope can also drop ranked rows, so it
    // shares the property filter's overfetch. The default (no scope)
    // path does NOT overfetch up front - all-untagged vaults stay
    // byte-identical to prior behaviour - and instead relies on the
    // one-shot backfill below when tagged pages actually shrink the
    // window.
    const visibilityScope = normalizeVisibilityScope(opts.visibility ?? []);
    const hasVisibilityRequest = (opts.visibility?.length ?? 0) > 0;
    const hasFrontmatterFilter = hasPropertyFilter || hasVisibilityRequest;

    // MMR and traversal both need a candidate pool wider than `limit`:
    // MMR diversifies from it, and traversal seeds expansion from it (a
    // narrow pool lets a high-parent expansion crowd a genuine but
    // lower-ranked hit out of the final window). When both are disabled
    // the pool collapses back to the historical rankLimit.
    const mmrLambda = opts.mmrLambda ?? config.recall.mmrLambda;
    const mmrActive = mmrLambda < 1;
    const maxHops = opts.maxHops ?? config.recall.maxHops;
    const traversalActive = maxHops > 0;
    const baseRankLimit = hasFrontmatterFilter ? Math.max(limit * 5, 50) : limit;
    const rankLimit =
      mmrActive || traversalActive ? Math.max(baseRankLimit, limit * 3, 30) : baseRankLimit;

    // Rank → traverse → diversify → property filter → visibility scope,
    // for a given candidate cap. Returns the pre-visibility count, the
    // post-visibility list, and whether the cap was actually hit (so the
    // caller can tell "the pool ran out" from "the cap truncated more").
    const assemble = (
      rankCap: number,
    ): {
      preVisibility: number;
      visible: ReadonlyArray<BrainSearchResult>;
      capHit: boolean;
    } => {
      let ranked = rankResults(
        {
          keyword: kwHits,
          semantic: semHits,
          hydrated,
          inboundLinkSources,
          tagsByDoc,
          ...(entityMatchByChunk !== undefined ? { entityMatchByChunk } : {}),
        },
        {
          keywordWeight: opts.keywordWeight ?? config.keywordWeight,
          semanticWeight: opts.semanticWeight ?? config.semanticWeight,
          limit: rankCap,
          semanticEnabled: policy.wantSemantic && semanticAttempted,
          recency: {
            shape: config.recall.recencyShape,
            scale: config.recall.recencyScale,
            amplitude: config.recall.recencyAmplitude,
          },
          ...(weightProfile !== undefined ? { weightProfile } : {}),
          ...(sessionFocus !== undefined ? { sessionFocus } : {}),
        },
      );
      const capHit = ranked.length >= rankCap;
      // Link-graph traversal (v0.13.0): walk outbound links from the top
      // hits and surface related documents not already matched, scored by
      // decay. No-op when maxHops == 0. Runs before MMR so expansions are
      // subject to the same diversity pass.
      if (traversalActive && ranked.length > 0) {
        ranked = applyTraversal(store, ranked, {
          maxHops,
          hopDecay: config.recall.hopDecay,
          maxExpansionPerHit: config.recall.maxExpansionPerHit,
        });
      }
      // Diversity rerank (v0.13.0). No-op when lambda >= 1 or < 2 results.
      if (mmrActive) {
        ranked = mmrRerank(ranked, { lambda: mmrLambda });
      }
      // Optional post-rank property filter (v0.10.17). Reads each
      // result's source frontmatter and drops rows whose scalars do not
      // match the requested key/value pairs, then visibility scoping (v3)
      // drops pages outside the requested visibility scope. Caching by
      // document path bounds the read cost to the result set.
      const propFiltered = hasPropertyFilter
        ? applyPropertyFilter(ranked, opts.properties!, config.vault)
        : ranked;
      const visible = applyVisibilityScope(propFiltered, visibilityScope, config.vault);
      return { preVisibility: propFiltered.length, visible, capHit };
    };

    let assembled = assemble(rankLimit);
    // Default-scope visibility (no explicit filter, so no overfetch above)
    // can drop tagged pages and leave fewer than `limit` rows while more
    // untagged matches sit deeper in the candidate pool. When that happens
    // and the narrow cap was actually hit, re-assemble once at the wider
    // cap from the same in-memory candidates - no extra DB fetch. Untagged
    // vaults never drop rows, so this never fires and their results stay
    // byte-identical.
    if (
      !hasFrontmatterFilter &&
      assembled.visible.length < limit &&
      assembled.visible.length < assembled.preVisibility &&
      assembled.capHit
    ) {
      const wideCap = Math.max(limit * 5, 50, limit * 3, 30);
      if (wideCap > rankLimit) assembled = assemble(wideCap);
    }
    const filtered = applyStructuredExclusions(assembled.visible, structured).slice(0, limit);

    // Typed graph semantics (v3): surface the typed relations each
    // result page declares in its frontmatter. Computed here from the
    // links table, never stored on the result row. One batched query.
    const relByDoc = store.typedRelationsForDocuments(filtered.map((r) => r.documentId));
    const withRelations = filtered.map((r) => {
      const rels = relByDoc.get(r.documentId);
      return rels && rels.length > 0 ? { ...r, relations: Object.freeze(rels) } : r;
    });
    const withStructuredReasons = addStructuredReasons(withRelations, structured);
    const finalResults =
      opts.evidencePack === true
        ? downrankTerminalEvidenceResults(withStructuredReasons)
        : withStructuredReasons;
    const evidencePack =
      opts.evidencePack === true ? buildEvidencePack(query, finalResults) : undefined;

    return finalize(
      Object.freeze({
        results: Object.freeze(finalResults),
        warnings: Object.freeze(warnings),
        total: finalResults.length,
        ...(evidencePack !== undefined ? { evidencePack } : {}),
      }),
    );
  } finally {
    await store.close();
  }
}

/**
 * Walk outbound links from the ranked hits and merge in related
 * documents. Fetches the outbound adjacency level-by-level (each
 * document fetched once) up to `maxHops`, then delegates the bounded
 * scoring to the pure `expandByTraversal`.
 */
function applyTraversal(
  store: Store,
  ranked: BrainSearchResult[],
  opts: TraversalOptions,
): BrainSearchResult[] {
  const seedDocIds = Array.from(new Set(ranked.map((r) => r.documentId)));
  const present = new Set(seedDocIds);
  const outbound = new Map<number, ReadonlyArray<number>>();
  const seen = new Set<number>(seedDocIds);
  let level = new Set<number>(seedDocIds);

  for (let hop = 0; hop < opts.maxHops && level.size > 0; hop++) {
    const toFetch = Array.from(level).filter((id) => !outbound.has(id));
    if (toFetch.length === 0) break;
    const adjacency = store.outboundLinkTargets(toFetch);
    const next = new Set<number>();
    for (const [src, targets] of adjacency) {
      outbound.set(src, targets);
      for (const t of targets) {
        if (!seen.has(t)) {
          seen.add(t);
          next.add(t);
        }
      }
    }
    level = next;
  }

  const expansionIds = Array.from(seen).filter((id) => !present.has(id));
  if (expansionIds.length === 0) return ranked;
  const reps = store.representativeChunks(expansionIds);

  return expandByTraversal(
    {
      ranked,
      outbound,
      expansionDoc: (docId) => {
        const h = reps.get(docId);
        if (!h) return null;
        return {
          documentId: h.documentId,
          chunkId: h.chunkId,
          path: h.path,
          title: h.title,
          content: h.content,
          startLine: h.startLine,
          endLine: h.endLine,
        };
      },
    },
    opts,
  );
}

function applyPropertyFilter(
  ranked: ReadonlyArray<BrainSearchResult>,
  filters: ReadonlyMap<string, ReadonlyArray<string>>,
  vault: string,
): ReadonlyArray<BrainSearchResult> {
  const cache = new Map<string, Record<string, unknown> | null>();
  const reader = (path: string): Record<string, unknown> | null => {
    if (cache.has(path)) return cache.get(path) ?? null;
    try {
      const [meta] = parseFrontmatter(join(vault, path));
      cache.set(path, meta as Record<string, unknown>);
      return meta as Record<string, unknown>;
    } catch {
      cache.set(path, null);
      return null;
    }
  };
  return filterByProperties(ranked, filters, reader);
}

function applyVisibilityScope(
  ranked: ReadonlyArray<BrainSearchResult>,
  scope: ReadonlySet<string>,
  vault: string,
): ReadonlyArray<BrainSearchResult> {
  const cache = new Map<string, string[]>();
  const tagsFor = (path: string): string[] => {
    const cached = cache.get(path);
    if (cached) return cached;
    let tags: string[] = [];
    try {
      const [meta] = parseFrontmatter(join(vault, path));
      tags = pageVisibility(meta);
    } catch {
      tags = [];
    }
    cache.set(path, tags);
    return tags;
  };
  return ranked.filter((r) => isVisible(tagsFor(r.path), scope));
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
  if (!config.semantic.apiKey) {
    if (opts.explicit) {
      throw new SearchError("EMBEDDING_KEY_MISSING", "embedding key not configured");
    }
    warnings.push("embedding key not configured; semantic disabled");
    return { attempted: false, hits: [], warnings };
  }

  let queryVec: number[];
  try {
    const provider = makeProvider(config.semantic);
    const vectors = await provider.embed([query]);
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
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`embedding provider unavailable: ${msg}`);
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
