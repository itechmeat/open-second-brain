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
import {
  composeWeightProfiles,
  fnv1aHex,
  isNeutralLearnedWeights,
  learnedWeightsFingerprint,
  learnedWeightsReason,
  readLearnedWeights,
} from "./feedback.ts";
import { parseFreshnessTrend } from "../brain/temporal/freshness-trend.ts";
import { effectiveActivation, halfLifeDays, resolveActivationKind } from "./activation/decay.ts";
import {
  ACCESS_EVENT_PATHS_CAP,
  CO_ACCESS_MIN_COUNT,
  activationStateFingerprint,
  readActivationState,
  recordAccessEvent,
} from "./activation/store.ts";
import { extractEntities } from "./entities.ts";
import { expandQueryEntities } from "./entity-alias.ts";
import { buildCoverageReport, significantTerms, termIncludedIn } from "./coverage.ts";
import { buildEvidencePack, downrankTerminalEvidenceResults } from "./evidence-pack.ts";
import type { EvidenceUnionRecord, EvidenceVerification } from "./evidence-pack.ts";
import { runFtsQueryDetailed } from "./fts.ts";
import { mmrRerank } from "./mmr.ts";
import { buildQueryPlan } from "./query-plan.ts";
import { buildCacheKey, getCachedOutcome, putCachedOutcome } from "./query-cache.ts";
import { deriveExpansionTerms, tokenizeForExpansion, DEFAULT_EXPANSION } from "./synonyms.ts";
import { filterByProperties } from "./property-filter.ts";
import { applyRelationPolarity } from "./relation-polarity.ts";
import { rankResults } from "./ranker.ts";
import { readActiveSessionFocus } from "./session-focus.ts";
import { resolveTimeRange } from "./time-range.ts";
import { eventTimeInRange, parseValidityWindow, type ValidityWindow } from "./validity.ts";
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
    relPol: r.relationPolarityEnabled,
    lw: r.learnedWeightsEnabled,
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

/**
 * Open the index for reading, self-healing a stale or absent index. After a
 * plugin upgrade the on-disk index can be a different schema version
 * (`SCHEMA_MISMATCH`) or not yet built (`INDEX_MISSING`); rather than forcing
 * the user to run `o2b search reindex` / `o2b search index`, rebuild once and
 * retry. `reindexVault` is imported lazily so the hot path never pulls in the
 * indexer and there is no module cycle.
 */
async function openReadOrSelfHeal(config: ResolvedSearchConfig): Promise<Store> {
  try {
    return await Store.open(config, { mode: "read" });
  } catch (e) {
    if (e instanceof SearchError && (e.code === "INDEX_MISSING" || e.code === "SCHEMA_MISMATCH")) {
      try {
        const { reindexVault } = await import("./indexer.ts");
        await reindexVault(config);
      } catch {
        // A concurrent writer may already be rebuilding (INDEX_LOCKED), or the
        // rebuild failed - fall through and let the retry surface real state.
      }
      return await Store.open(config, { mode: "read" });
    }
    throw e;
  }
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
    opts.sessionFocus === undefined
      ? readActiveSessionFocus(config, opts.focusSession, Date.now())
      : opts.sessionFocus;
  const keywordQuery = structuredKeywordQuery(query, structured);
  const semanticLaneQuery = structuredSemanticQuery(structured);
  // Time-aware recall (recall-trust-suite): resolve since/until up front
  // so invalid input fails fast, before any store I/O.
  const timeRange =
    opts.since !== undefined || opts.until !== undefined
      ? resolveTimeRange({ since: opts.since, until: opts.until }, Date.now())
      : null;

  // Query plan (v0.20.0): one structural pass yields the intent weight
  // profile and the cache key. Pure; no I/O. Expanded terms (if any) are
  // folded in once they have been derived from the store below.
  const basePlan = buildQueryPlan(keywordQuery, [], structured?.intent);

  // Read-only origins (cross-vault search) disable self-healing: a
  // rebuild would write an index INTO the external vault. Default
  // (selfHeal absent) keeps the legacy heal-and-retry behaviour.
  const store =
    opts.selfHeal === false
      ? await Store.open(config, { mode: "read" })
      : await openReadOrSelfHeal(config);
  try {
    // Persistent query cache (v0.20.0): opt-in. Keyed by the request +
    // base plan hash + a config fingerprint, gated by the corpus
    // generation and a TTL. A hit returns the previously computed
    // outcome; generation changes (embedding change or content reindex)
    // and TTL expiry invalidate it. Expansion terms are not in the key:
    // they are determined by (query, index content) and any content
    // change bumps the generation. The cache write is best-effort.
    // A time-filtered query bypasses the cache: a relative range
    // ("24h") resolves to a different absolute window on every call, so
    // a cached row would serve a stale window within the TTL.
    const cacheEnabled = config.recall.cacheEnabled && timeRange === null;
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
        // The learned-weights state changes results outside the static
        // config, so its fingerprint joins the key (recall-trust-suite).
        const lwFp = config.recall.learnedWeightsEnabled
          ? learnedWeightsFingerprint(config.vault)
          : "off";
        // The activation state evolves with recorded accesses the same
        // way, so its fingerprint joins too (Time-Aware Recall Suite).
        const actFp = config.recall.activationEnabled
          ? activationStateFingerprint(config.vault)
          : "off";
        cacheKey = buildCacheKey(
          keyOpts,
          basePlan.planHash,
          `${configFingerprint(config)}|lw:${lwFp}|act:${actFp}`,
        );
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
    const intentProfile = config.recall.intentEnabled ? plan.weightProfile : undefined;
    // Learned recall weights (recall-trust-suite): opt-in multipliers
    // derived from explicit feedback compose with the intent profile.
    // Both factors are bounded, so the product is too; neutral learned
    // weights leave ranking bit-identical.
    const learned = config.recall.learnedWeightsEnabled ? readLearnedWeights(config.vault) : null;
    const learnedActive = learned !== null && !isNeutralLearnedWeights(learned);
    const weightProfile = learnedActive
      ? composeWeightProfiles(intentProfile, learned)
      : intentProfile;

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
      const evidencePack =
        opts.evidencePack === true
          ? buildEvidencePack(query, [], buildEvidenceVerification(store, query, [], pathPrefix))
          : undefined;
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

    // Time-aware recall (recall-trust-suite): drop out-of-range
    // candidates BEFORE ranking so every later phase (traversal seeds,
    // MMR, relation polarity) sees only in-range candidates.
    // Event-time discipline (t_b7191486): a document declaring
    // `valid_from` / `valid_until` is tested by validity-window
    // OVERLAP - storage mtime is the fallback, never the authority,
    // when explicit event time exists. One cached frontmatter read per
    // candidate path; an unparseable declared value warns once and
    // falls back to mtime.
    if (timeRange !== null) {
      const windowCache = new Map<string, ValidityWindow | null>();
      const warnedInvalid = new Set<string>();
      const windowFor = (path: string): ValidityWindow | null => {
        if (windowCache.has(path)) return windowCache.get(path) ?? null;
        let window: ValidityWindow | null = null;
        try {
          const [meta] = parseFrontmatter(join(config.vault, path));
          window = parseValidityWindow(meta as Record<string, unknown>);
        } catch {
          window = null;
        }
        windowCache.set(path, window);
        return window;
      };
      const inRange = (chunkId: number): boolean => {
        const h = hydrated.get(chunkId);
        if (h === undefined) return false;
        const window = windowFor(h.path);
        if (window?.invalid === true && !warnedInvalid.has(h.path)) {
          warnedInvalid.add(h.path);
          warnings.push(`validity: unparseable valid_from/valid_until in ${h.path}; using mtime`);
        }
        return eventTimeInRange(window, h.mtime, timeRange);
      };
      kwHits = kwHits.filter((h) => inRange(h.chunkId));
      semHits = semHits.filter((h) => inRange(h.chunkId));
    }

    const inboundLinkSources = store.inboundLinkSources(idsList);
    const tagsByDoc = store.tagsByChunkDocument(idsList);

    // Entity-boosted retrieval (v0.13.0): extract entities from the
    // query and count overlaps with each candidate chunk. Empty when the
    // query names no entities or the index predates the entity store.
    // The canonical entity registry (Memory Integrity Suite) expands the
    // set so a query naming an alias also matches chunks naming the
    // canonical entity; identity expansion (no registry) keeps ranking
    // bit-identical to pre-registry behaviour.
    const queryEntities = extractEntities(query);
    const entityExpansion = expandQueryEntities(config.vault, queryEntities);
    const entityMatchByChunk =
      entityExpansion.expanded.length > 0
        ? store.chunkEntityMatches(idsList, entityExpansion.expanded)
        : undefined;
    // Canonical-hop attribution: chunks matching a registry-ADDED form
    // carry an explicit reason naming the canonical entity ids below.
    const canonicalMatchByChunk =
      entityExpansion.added.length > 0
        ? store.chunkEntityMatches(idsList, entityExpansion.added)
        : undefined;

    // Access-reinforced activation (Time-Aware Recall & Activation
    // Suite): map the derived activation state onto the candidate set.
    // O(candidates): one state read per query, one frontmatter read per
    // candidate path that actually carries activation. The type
    // half-life decays the stored strength at read time, so a vault
    // without recorded events contributes nothing and ranks
    // bit-identically.
    let activationByChunk: ReadonlyMap<number, number> | undefined;
    let coAccessByChunk: ReadonlyMap<number, ReadonlyMap<number, number>> | undefined;
    if (config.recall.activationEnabled) {
      const activationState = readActivationState(config.vault);
      if (activationState !== null && Object.keys(activationState.paths).length > 0) {
        const nowActivationMs = Date.now();
        const kindCache = new Map<string, string>();
        const kindFor = (path: string): string => {
          const cached = kindCache.get(path);
          if (cached !== undefined) return cached;
          let fmKind: string | null = null;
          try {
            const [meta] = parseFrontmatter(join(config.vault, path));
            const raw = (meta as Record<string, unknown>)["kind"];
            fmKind = typeof raw === "string" ? raw : null;
          } catch {
            fmKind = null;
          }
          const kind = resolveActivationKind(fmKind, path);
          kindCache.set(path, kind);
          return kind;
        };
        const byChunk = new Map<number, number>();
        for (const chunkId of idsList) {
          const h = hydrated.get(chunkId);
          if (h === undefined) continue;
          const row = activationState.paths[h.path];
          if (row === undefined) continue;
          const days = (nowActivationMs - row.lastAccessAt) / (24 * 60 * 60 * 1000);
          const act = effectiveActivation(row.strength, days, halfLifeDays(kindFor(h.path)));
          if (act > 0) byChunk.set(chunkId, act);
        }
        if (byChunk.size > 0) activationByChunk = byChunk;
      }
      // Co-access companions (t_c5ef25a3): restrict the recorded pairs
      // to documents present in this candidate set, then hand each
      // chunk its companion documentIds with pair counts. Pairs seen
      // fewer than CO_ACCESS_MIN_COUNT times are noise and skipped.
      if (activationState !== null && activationState.coAccess.length > 0) {
        const docIdByPath = new Map<string, number>();
        const chunksByDocId = new Map<number, number[]>();
        for (const chunkId of idsList) {
          const h = hydrated.get(chunkId);
          if (h === undefined) continue;
          docIdByPath.set(h.path, h.documentId);
          const list = chunksByDocId.get(h.documentId) ?? [];
          list.push(chunkId);
          chunksByDocId.set(h.documentId, list);
        }
        const companionsByChunk = new Map<number, Map<number, number>>();
        const addCompanion = (ownDoc: number, otherDoc: number, count: number): void => {
          for (const chunkId of chunksByDocId.get(ownDoc) ?? []) {
            const m = companionsByChunk.get(chunkId) ?? new Map<number, number>();
            m.set(otherDoc, Math.max(m.get(otherDoc) ?? 0, count));
            companionsByChunk.set(chunkId, m);
          }
        };
        for (const pair of activationState.coAccess) {
          if (pair.count < CO_ACCESS_MIN_COUNT) continue;
          const docA = docIdByPath.get(pair.a);
          const docB = docIdByPath.get(pair.b);
          if (docA === undefined || docB === undefined) continue;
          addCompanion(docA, docB, pair.count);
          addCompanion(docB, docA, pair.count);
        }
        if (companionsByChunk.size > 0) coAccessByChunk = companionsByChunk;
      }
    }

    // Freshness-trend bias (t_ee09a6ce): preference pages stamped with
    // a `freshness_trend` by the dream refresh get a bounded relevance
    // multiplier. Restricted to Brain/preferences/ paths - the stamp is
    // a preference-lifecycle field, not a generic page property - and
    // O(candidate preference pages) frontmatter reads.
    let trendByDoc: ReadonlyMap<number, string> | undefined;
    {
      const byDoc = new Map<number, string>();
      const seenDocs = new Set<number>();
      for (const chunkId of idsList) {
        const h = hydrated.get(chunkId);
        if (h === undefined || seenDocs.has(h.documentId)) continue;
        seenDocs.add(h.documentId);
        if (!h.path.startsWith("Brain/preferences/")) continue;
        try {
          const [meta] = parseFrontmatter(join(config.vault, h.path));
          const trend = parseFreshnessTrend((meta as Record<string, unknown>)["freshness_trend"]);
          if (trend !== null) byDoc.set(h.documentId, trend);
        } catch {
          // Unreadable frontmatter stays neutral.
        }
      }
      if (byDoc.size > 0) trendByDoc = byDoc;
    }

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
    const hasStructuredExclusions = (structured?.lex.exclude.length ?? 0) > 0;
    const mmrLambda = opts.mmrLambda ?? config.recall.mmrLambda;
    const mmrActive = mmrLambda < 1;
    const maxHops = opts.maxHops ?? config.recall.maxHops;
    const traversalActive = maxHops > 0;
    const baseRankLimit =
      hasFrontmatterFilter || hasStructuredExclusions ? Math.max(limit * 5, 50) : limit;
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
          ...(activationByChunk !== undefined ? { activationByChunk } : {}),
          ...(coAccessByChunk !== undefined ? { coAccessByChunk } : {}),
          ...(trendByDoc !== undefined ? { trendByDoc } : {}),
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
          fusionMode: config.fusionMode,
          rrfK: config.rrfK,
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
    const excluded = applyStructuredExclusions(assembled.visible, structured);
    // Relation polarity (recall-trust-suite): typed relation edges adjust
    // the pool BEFORE the final slice so a demoted predecessor can fall
    // out of the window and a pulled-in successor can enter it. A pool
    // whose documents declare no typed edges passes through untouched.
    const polarized = config.recall.relationPolarityEnabled
      ? applyRelationPolarityPhase(store, excluded, opts.includeSuperseded === true)
      : excluded;
    const sliced = polarized.slice(0, limit);
    // Explainability: when learned weights affected this ranking, every
    // surfaced result says so (acceptance: "search explanations show
    // when learned weights affected a result").
    const filtered = learnedActive
      ? sliced.map((r) =>
          Object.freeze({
            ...r,
            reasons: Object.freeze([...r.reasons, learnedWeightsReason(learned)]),
          }),
        )
      : sliced;

    // Typed graph semantics (v3): surface the typed relations each
    // result page declares in its frontmatter. Computed here from the
    // links table, never stored on the result row. One batched query.
    const relByDoc = store.typedRelationsForDocuments(filtered.map((r) => r.documentId));
    const withRelations = filtered.map((r) => {
      const rels = relByDoc.get(r.documentId);
      return rels && rels.length > 0 ? { ...r, relations: Object.freeze(rels) } : r;
    });
    const withStructuredReasons = addStructuredReasons(withRelations, structured);
    // Canonical-entity attribution (Memory Integrity Suite): a hit whose
    // chunk matched a registry-added form explains the alias hop. Vaults
    // without a registry never reach this branch.
    const withCanonicalReasons =
      canonicalMatchByChunk !== undefined
        ? withStructuredReasons.map((r) =>
            (canonicalMatchByChunk.get(r.chunkId) ?? 0) > 0
              ? Object.freeze({
                  ...r,
                  reasons: Object.freeze([
                    ...r.reasons,
                    `entity_canonical: ${entityExpansion.sourceIds.join(", ")}`,
                  ]),
                })
              : r,
          )
        : withStructuredReasons;
    const finalResults =
      opts.evidencePack === true
        ? downrankTerminalEvidenceResults(withCanonicalReasons)
        : withCanonicalReasons;
    const evidencePack =
      opts.evidencePack === true
        ? buildEvidencePack(
            query,
            finalResults,
            buildEvidenceVerification(store, query, finalResults, pathPrefix),
          )
        : undefined;

    // Access recording (Time-Aware Recall & Activation Suite): the
    // orchestrator edge opted in, so persist which documents this query
    // surfaced - AFTER ranking, so the current query is never affected
    // by its own recording. Cache hits return earlier and never reach
    // this point. Best-effort: a failed write never breaks the search.
    if (opts.recordAccess === true && config.recall.activationEnabled && finalResults.length > 0) {
      const surfacedPaths = Array.from(new Set(finalResults.map((r) => r.path))).slice(
        0,
        ACCESS_EVENT_PATHS_CAP,
      );
      const normalized = query.trim().replace(/\s+/gu, " ").toLowerCase();
      try {
        recordAccessEvent(config.vault, {
          ts: Date.now(),
          queryHash: fnv1aHex(normalized),
          paths: surfacedPaths,
        });
      } catch {
        warnings.push("activation: failed to record access event");
      }
    }

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

/** Cap on extra records fetched per uncovered term (Feature C union). */
const UNION_RECORDS_PER_TERM = 2;
/** Cap on the total recall-union fetch per query. */
const UNION_RECORDS_TOTAL = 8;

/**
 * Coverage verification for evidence-pack mode (recall-trust-suite,
 * Feature C): corpus document frequencies for the significant terms,
 * the covered-term set over the returned results, and a bounded
 * per-token recall union — for each term the ranked set left uncovered,
 * fetch up to {@link UNION_RECORDS_PER_TERM} records that DO cover it
 * (evidence can span records the primary ranking never surfaced).
 */
function buildEvidenceVerification(
  store: Store,
  query: string,
  results: ReadonlyArray<BrainSearchResult>,
  pathPrefix: string | undefined,
): EvidenceVerification {
  const terms = significantTerms(query);
  const dfByTerm = store.documentFrequencies(terms);
  const documentCount = store.counts().documents;
  const covered = new Set<string>();
  for (const r of results) {
    const haystack = `${r.path}\n${r.title ?? ""}\n${r.content}`;
    for (const t of terms) {
      if (!covered.has(t) && termIncludedIn(haystack, t)) covered.add(t);
    }
  }
  const coverage = buildCoverageReport({
    significantTerms: terms,
    coveredTerms: covered,
    documentCount,
    dfByTerm,
  });

  const unionRecords: EvidenceUnionRecord[] = [];
  for (const t of coverage.terms) {
    if (t.covered || t.df === 0) continue; // nothing in the corpus covers a df=0 term
    if (unionRecords.length >= UNION_RECORDS_TOTAL) break;
    const outcome = runFtsQueryDetailed(store, t.term, {
      limit: UNION_RECORDS_PER_TERM,
      pathPrefix,
    });
    const ids = outcome.hits.map((h) => h.chunkId);
    const hydrated = store.hydrateChunks(ids);
    for (const hit of outcome.hits) {
      if (unionRecords.length >= UNION_RECORDS_TOTAL) break;
      const h = hydrated.get(hit.chunkId);
      if (!h) continue;
      unionRecords.push(
        Object.freeze({
          term: t.term,
          path: h.path,
          documentId: h.documentId,
          chunkId: h.chunkId,
        }),
      );
    }
  }
  return Object.freeze({ coverage, unionRecords: Object.freeze(unionRecords) });
}

/**
 * Fetch the typed relation edges declared by the pool's documents and
 * delegate the polarity adjustment to the pure `applyRelationPolarity`.
 * Successor pull-in reuses the traversal layer's representative-chunk
 * mechanism (document head as the surfaced chunk).
 */
function applyRelationPolarityPhase(
  store: Store,
  ranked: ReadonlyArray<BrainSearchResult>,
  includeSuperseded: boolean,
): ReadonlyArray<BrainSearchResult> {
  if (ranked.length === 0) return ranked;
  const docIds = Array.from(new Set(ranked.map((r) => r.documentId)));
  const edges = store.typedRelationEdgesForDocuments(docIds);
  if (edges.length === 0) return ranked;

  const present = new Set(docIds);
  const successorIds = Array.from(
    new Set(
      edges
        .map((e) => e.targetDocumentId)
        .filter((id): id is number => id !== null && !present.has(id)),
    ),
  );
  const reps = store.representativeChunks(successorIds);

  return applyRelationPolarity(
    {
      ranked,
      edges,
      successorDoc: (docId) => {
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
    { includeSuperseded },
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
