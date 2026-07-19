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

import { statSync } from "node:fs";
import { join } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { normalizeVisibilityScope } from "../graph/visibility.ts";
import { normalizeAgentScope } from "../graph/agent-scope.ts";
import { canonicalSourceSetKey, normalizeScopeFilter, rrfKey } from "../scope-key.ts";
import { DEFAULT_RELATION_TYPES, normalizeRelation } from "../graph/relation-vocab.ts";
import { loadSchemaPack } from "../brain/schema-pack.ts";
import { parseRelationalQuery } from "./relational-query.ts";
import { relationalFanout } from "./relational-fanout.ts";
import { isLowSelectivity, planTrigramPrefilter } from "./trigram-prefilter.ts";
import {
  composeWeightProfiles,
  fnv1aHex,
  isNeutralLearnedWeights,
  learnedWeightsFingerprint,
  learnedWeightsReason,
  readLearnedWeights,
} from "./feedback.ts";
import { parseFreshnessTrend } from "../brain/temporal/freshness-trend.ts";
import { observedReuseRates } from "../brain/observed-use.ts";
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
import {
  COMPLETENESS_COMPLETE_THRESHOLD,
  planTargetedRetry,
  significantTerms,
} from "./coverage.ts";
import { buildEvidencePack, downrankTerminalEvidenceResults } from "./evidence-pack.ts";
import { runFtsQueryDetailed } from "./fts.ts";
import { mmrRerank } from "./mmr.ts";
import { buildQueryPlan } from "./query-plan.ts";
import { buildCacheKey, getCachedOutcome, putCachedOutcome } from "./query-cache.ts";
import { deriveExpansionTerms, tokenizeForExpansion, DEFAULT_EXPANSION } from "./synonyms.ts";
import { rankResults } from "./ranker.ts";
import { applyRankAdjusters, type RankAdjuster } from "./rank-adjust.ts";
import { trustGateAdjuster } from "../brain/trust/retrieval-gate.ts";
import {
  buildMemoryTrustAssessment,
  buildRetrievalDecisionTrace,
} from "../brain/trust/retrieval-receipts.ts";
import { detectHybridDegrade, rerankByRelevance } from "./enrich.ts";
import { applyReinforceBoost, loadReinforceStrengths, reinforceFingerprint } from "./reinforce.ts";
import { readActiveSessionFocus } from "./session-focus.ts";
import { applyTemporalBridge } from "./temporal-bridge.ts";
import { resolveTimeRange } from "./time-range.ts";
import { eventTimeInRange, parseValidityWindow, type ValidityWindow } from "./validity.ts";
import { Store } from "./store.ts";
import { SearchError } from "./types.ts";
import type {
  BrainSearchResult,
  ResolvedSearchConfig,
  SearchOptions,
  SearchOutcome,
} from "./types.ts";
import { expandQuery } from "./query-expansion.ts";
import { applyTunedParameters, loadTunedParameters } from "./tuning-store.ts";
import { resolveRecallProfile } from "./profiles.ts";
import { applyCrossEncoderRerank } from "./rerank/index.ts";
import { emitGatedTelemetry } from "../brain/continuity/emit.ts";
import {
  addStructuredReasons,
  applyStructuredExclusions,
  structuredKeywordQuery,
  structuredSemanticQuery,
} from "./structured-lanes.ts";
import { resolveSemanticPolicy, runSemanticPhase, semanticPoolSize } from "./semantic-phase.ts";
import { toSearchCard } from "./cards.ts";
import {
  applyAgentScope,
  applyDegreeFilter,
  applyExactStateBarrier,
  applyPropertyFilter,
  applyScopeFilter,
  applyStatusFilter,
  applyVisibilityScope,
  attachTrustMetadata,
  buildTerminalPaths,
  readCachedFrontmatter,
  supersedeFadeAdjuster,
} from "./result-filters.ts";
import { applyRelationPolarityPhase, applyTraversal } from "./graph-phases.ts";
import { buildEvidenceVerification, coverageOverChunks } from "./evidence-verification.ts";

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
    relArm: r.relationalArmEnabled,
    trustGate: r.retrievalTrustGateEnabled,
    supFade: r.supersedeFadeEnabled,
    lw: r.learnedWeightsEnabled,
    // Cross-encoder rerank re-orders the cached outcome, so a toggle or
    // knob change must invalidate cached rows (the endpoint identity is
    // omitted - a key rotation on the same model does not change ordering
    // semantics, and secrets never belong in a cache key).
    rrk: config.rerank.enabled,
    rrkModel: config.rerank.model,
    rrkTopK: config.rerank.topK,
    rrkMin: config.rerank.minScore,
    // Trigram prefilter augments the candidate pool, so a toggle or
    // selectivity change must invalidate cached rows.
    tri: r.trigramPrefilterEnabled,
    triMin: r.trigramPrefilterMinChunks,
    triSel: r.trigramPrefilterMaxSelectivity,
  });
}

function assertSafePathPrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  if (prefix.includes("..") || prefix.startsWith("/")) {
    throw new SearchError("INVALID_INPUT", "path_prefix escapes vault");
  }
  return prefix;
}

/**
 * Open the index for reading, self-healing a stale, absent, or unreadable
 * index. After a plugin upgrade the on-disk index can be a different schema
 * version (`SCHEMA_MISMATCH`), not yet built (`INDEX_MISSING`), or corrupt
 * / truncated / non-OSB at the index path (`INDEX_UNREADABLE`); rather than
 * forcing the user to run `o2b search reindex` / `o2b search index`, rebuild
 * once and retry. `reindexVault` is imported lazily so the hot path never
 * pulls in the indexer and there is no module cycle.
 */
async function openReadOrSelfHeal(config: ResolvedSearchConfig): Promise<Store> {
  try {
    return await Store.open(config, { mode: "read" });
  } catch (e) {
    if (
      e instanceof SearchError &&
      (e.code === "INDEX_MISSING" || e.code === "SCHEMA_MISMATCH" || e.code === "INDEX_UNREADABLE")
    ) {
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

/**
 * Bounds for the public `limit` option. CLI validates against the same
 * ceiling before calling in; MCP applies its own, lower `MCP_LIMIT_MAX`
 * (token-budget conscious) - the two ceilings are deliberately different,
 * this just gives the shared one a name instead of a bare `100` literal.
 */
export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_MAX = 100;

export async function search(
  config: ResolvedSearchConfig,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  const query = (opts.query ?? "").trim();
  if (!query) {
    throw new SearchError("INVALID_INPUT", "missing required argument: query");
  }
  // Recall profile (Recall & Working-Memory Quality Suite, t_98c39dd6) and
  // opt-in self-tuning (t_ae973491) resolve to the SAME knob tuple, applied
  // through applyTunedParameters (which disarms selfTuningEnabled so the
  // applied config can never recurse). An explicitly selected profile is an
  // operator choice and takes precedence over the persisted grid point; with
  // no profile, behaviour is unchanged - self-tuning applies iff enabled. An
  // explicit opts.expand always wins over the resolved expansion default.
  const profileParams = opts.profile !== undefined ? resolveRecallProfile(opts.profile) : null;
  const tuned =
    profileParams ?? (config.recall.selfTuningEnabled ? loadTunedParameters(config.vault) : null);
  if (tuned !== null) config = applyTunedParameters(config, tuned);
  const expandActive = opts.expand ?? (tuned !== null && tuned.expansion);
  const limit = Math.max(SEARCH_LIMIT_MIN, Math.min(SEARCH_LIMIT_MAX, opts.limit ?? 10));
  if (opts.threshold !== undefined && (!Number.isFinite(opts.threshold) || opts.threshold < 0)) {
    throw new SearchError("INVALID_INPUT", "threshold must be a finite number >= 0");
  }
  const pathPrefix = assertSafePathPrefix(opts.pathPrefix);
  const policy = resolveSemanticPolicy(config, opts);
  const warnings: string[] = [];
  const sessionFocus =
    opts.sessionFocus === undefined
      ? readActiveSessionFocus(config, opts.focusSession, Date.now())
      : opts.sessionFocus;
  // Time-aware recall (recall-trust-suite): resolve since/until up front
  // so invalid input fails fast, before any store I/O.
  const timeRange =
    opts.since !== undefined || opts.until !== undefined
      ? resolveTimeRange({ since: opts.since, until: opts.until }, Date.now())
      : null;

  // Read-only origins (cross-vault search) disable self-healing: a
  // rebuild would write an index INTO the external vault. Default
  // (selfHeal absent) keeps the legacy heal-and-retry behaviour.
  const store =
    opts.selfHeal === false
      ? await Store.open(config, { mode: "read" })
      : await openReadOrSelfHeal(config);
  try {
    // Shared across every frontmatter-reading filter stage below (Plan 1,
    // 1.3) so a candidate path already read by one stage is not re-read
    // and re-parsed by the next.
    const frontmatterCache = new Map<string, FrontmatterMap>();

    // Opt-in local expansion (t_2fa95db1): an explicit structured
    // document always wins; expansion only fills the gap. The lex lane's
    // corpus-common tokens are derived from document frequency here
    // (language-agnostic, no stopword list) so an implicit-AND query is
    // not killed by a word that is ubiquitous in this vault.
    const commonTokens =
      opts.structuredQuery === undefined && expandActive === true
        ? highFrequencyTokens(store, query)
        : new Set<string>();
    const structured =
      opts.structuredQuery ??
      (expandActive === true ? expandQuery(config.vault, query, { commonTokens }) : undefined);
    const keywordQuery = structuredKeywordQuery(query, structured);
    const semanticLaneQuery = structuredSemanticQuery(structured);
    // Query plan (v0.20.0): one structural pass yields the intent weight
    // profile and the cache key. Expanded terms (if any) are folded in
    // once they have been derived from the store below.
    const basePlan = buildQueryPlan(keywordQuery, [], structured?.intent);

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
        const tuneFp = tuned !== null ? JSON.stringify(tuned) : "off";
        // The reinforce ledger changes results only when the caller opted
        // in (Search & Recall Quality Suite); its fingerprint joins the
        // key just for those calls so an unrelated ledger write never
        // invalidates ordinary searches.
        const reinfFp = opts.reinforce !== undefined ? reinforceFingerprint(config.vault) : "off";
        // Federation hardening (t_09b7ccea): the query cache scopes by the
        // canonical source-set key, so a cache row is never served for a
        // different set of origins. Single-vault search draws from one
        // origin (this vault).
        const srcSet = canonicalSourceSetKey([config.vault]);
        cacheKey = buildCacheKey(
          keyOpts,
          basePlan.planHash,
          `${configFingerprint(config)}|lw:${lwFp}|act:${actFp}|tune:${tuneFp}|reinf:${reinfFp}|src:${srcSet}`,
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
      limit: limit * config.recall.poolMultiplier,
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
          limit: limit * config.recall.poolMultiplier,
          pathPrefix,
          expandedTerms,
        });
        kwHits = kwOutcome.hits;
        for (const w of kwOutcome.warnings) warnings.push(w);
      }
    }
    // Trigram candidate source (t_4a672b84): opt-in. On large vaults, merge
    // substring / partial-token matches the word tokenizer missed into the
    // keyword candidate pool. A strict superset of substring matches, so it
    // only ADDS candidates (deduped by chunkId; existing keyword hits keep
    // their bm25). Skipped for short/CJK/low-selectivity queries and when
    // disabled - leaving kwHits byte-identical.
    if (
      config.recall.trigramPrefilterEnabled &&
      store.chunkCount() >= config.recall.trigramPrefilterMinChunks
    ) {
      const trigramPlan = planTrigramPrefilter(query);
      if (trigramPlan.mode === "match") {
        const corpus = store.chunkCount();
        const cand = store.trigramCandidates(trigramPlan.ftsQuery, {
          limit: limit * config.recall.poolMultiplier,
          pathPrefix,
        });
        if (
          cand.length > 0 &&
          !isLowSelectivity(cand.length, corpus, config.recall.trigramPrefilterMaxSelectivity)
        ) {
          const seen = new Set(kwHits.map((h) => h.chunkId));
          for (const h of cand) {
            if (!seen.has(h.chunkId)) {
              kwHits.push(h);
              seen.add(h.chunkId);
            }
          }
        }
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
        limit: semanticPoolSize(limit),
        pathPrefix,
        explicit: policy.explicit,
      });
      semanticAttempted = semOutcome.attempted;
      semHits = semOutcome.hits;
      for (const w of semOutcome.warnings) warnings.push(w);
    }

    // Hybrid-degrade signal (Search & Recall Quality Suite): one
    // structural warning when the caller wanted the semantic lane but it
    // did not run, so the query was served keyword-only. The granular
    // runSemanticPhase warnings above explain WHY; this is the single
    // greppable flag a caller can test for.
    {
      const degrade = detectHybridDegrade({
        wantSemantic: policy.wantSemantic,
        semanticAttempted,
        keywordHitCount: kwHits.length,
      });
      if (degrade !== null) warnings.push(degrade);
    }

    // Typed-edge relational arm (t_09b7ccea): a fourth RRF arm. Engages
    // ONLY in rrf fusion, when enabled, for a relationship-shaped query (a
    // wikilink seed plus a schema-vocabulary edge-type token). A bounded
    // depth-2 typed-edge fan-out from the resolved seeds contributes ranked
    // related nodes. Off / linear fusion / a non-relational query leaves the
    // pool and ranking byte-identical. Source identity from the shared key
    // module dedups the lane (federation hardening).
    const relationalRankedChunkIds: number[] = [];
    const relationalMeta = new Map<number, { via: ReadonlyArray<string>; hops: number }>();
    const relationalArmActive =
      config.fusionMode === "rrf" && (opts.relationalArm ?? config.recall.relationalArmEnabled);
    if (relationalArmActive) {
      const relQuery = parseRelationalQuery(query, relationalEdgeVocabulary(config.vault));
      if (relQuery !== null) {
        const seedDocIds = resolveSeedDocumentIds(store, relQuery.seeds);
        if (seedDocIds.length > 0) {
          const nodes = relationalFanout(store, seedDocIds, {
            maxDepth: RELATIONAL_MAX_DEPTH,
            edgeTypes: relQuery.edgeTypes,
          });
          const reps = store.representativeChunks(nodes.map((n) => n.documentId));
          const seenKeys = new Set<string>();
          for (const node of nodes) {
            const rep = reps.get(node.documentId);
            if (rep === undefined) continue;
            const key = rrfKey({ origin: null, path: rep.path, chunkId: rep.chunkId });
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            relationalRankedChunkIds.push(rep.chunkId);
            relationalMeta.set(rep.chunkId, { via: node.viaLinkTypes, hops: node.hops });
          }
        }
      }
    }

    // Hydrate.
    const allChunkIds = new Set<number>();
    for (const h of kwHits) allChunkIds.add(h.chunkId);
    for (const h of semHits) allChunkIds.add(h.chunkId);
    for (const id of relationalRankedChunkIds) allChunkIds.add(id);
    let idsList = Array.from(allChunkIds);

    // Validity-window resolver (hoisted): used both by the time-range
    // filter below and by the targeted-retry coverage gate, which must
    // judge coverage over the IN-RANGE pool (see below). One cached
    // frontmatter read per candidate path.
    const validityWindowCache = new Map<string, ValidityWindow | null>();
    const validityWindowFor = (path: string): ValidityWindow | null => {
      if (validityWindowCache.has(path)) return validityWindowCache.get(path) ?? null;
      let window: ValidityWindow | null = null;
      try {
        const meta = readCachedFrontmatter(frontmatterCache, config.vault, path);
        window = parseValidityWindow(meta as Record<string, unknown>);
      } catch {
        window = null;
      }
      validityWindowCache.set(path, window);
      return window;
    };

    // Self-correcting two-pass recall (t_ef92dfdc): a zero-candidate
    // first pass in evidence-pack mode means the implicit-AND keyword
    // match was too strict - the classic abstention dead end. Instead
    // of returning empty, run EXACTLY ONE broadened retry that keeps
    // the first significant term as the base group and ORs the rest in
    // as alternatives, then let the merged pool flow through the normal
    // ranking, filters, and a recomputed evidence pack.
    let secondPass: SearchOutcome["secondPass"];
    // Chunk ids the targeted retry below recovered, so only those
    // results (not the first-pass hits they merge with) get the
    // second-pass attribution reason.
    const targetedChunkIds = new Set<number>();
    if (idsList.length === 0 && opts.evidencePack === true && config.recall.twoPassEnabled) {
      const terms = significantTerms(query);
      if (terms.length >= 2) {
        const broadened = runFtsQueryDetailed(store, terms[0]!, {
          expandedTerms: terms.slice(1),
          limit: semanticPoolSize(limit),
          pathPrefix: pathPrefix ?? null,
        });
        for (const w of broadened.warnings) warnings.push(w);
        if (broadened.hits.length > 0) {
          kwHits = broadened.hits;
          for (const h of kwHits) allChunkIds.add(h.chunkId);
          idsList = Array.from(allChunkIds);
          secondPass = Object.freeze({
            triggered: true,
            kind: "broadened",
            reason: "zero-candidate first pass; broadened OR retry",
            added: kwHits.length,
          });
        }
      }
    }

    // Coverage-driven targeted follow-up (t_8eb5ca32): the first pass
    // DID return candidates, but their IDF-weighted coverage of the
    // query is below the completeness threshold with rare query terms
    // still uncovered - a PARTIAL miss, distinct from the zero-candidate
    // dead end above. Issue exactly ONE targeted retry built from the
    // specifically-uncovered rare terms (not a generic broadening of the
    // whole query), merge the recovered candidates into the pool, and
    // let them flow through the normal ranking and a recomputed evidence
    // pack. Mutually exclusive with the broadened retry above (that needs
    // an empty pool, this a non-empty one), so at most one retry fires -
    // the same single-retry discipline. The trigger is deterministic and
    // LLM-free; the recomputed pack still abstains on any term left
    // uncovered after the retry.
    if (
      secondPass === undefined &&
      idsList.length > 0 &&
      opts.evidencePack === true &&
      config.recall.twoPassEnabled
    ) {
      // Judge coverage over the pool that will actually survive ranking:
      // for a time-scoped query, exclude out-of-range candidates first, so
      // a rare term is not marked "covered" only because an out-of-range
      // chunk matched it (which would wrongly suppress the retry while the
      // final in-range result set still misses that term).
      let coverageIds = idsList;
      if (timeRange !== null) {
        const hydratedForCoverage = store.hydrateChunks(idsList);
        coverageIds = idsList.filter((chunkId) => {
          const chunk = hydratedForCoverage.get(chunkId);
          if (chunk === undefined) return false;
          return eventTimeInRange(validityWindowFor(chunk.path), chunk.mtime, timeRange);
        });
      }
      const poolCoverage = coverageOverChunks(store, query, coverageIds);
      const plan = planTargetedRetry(poolCoverage);
      if (plan.fire) {
        const targeted = runFtsQueryDetailed(store, plan.terms[0]!, {
          expandedTerms: plan.terms.slice(1),
          limit: semanticPoolSize(limit),
          pathPrefix: pathPrefix ?? null,
        });
        for (const w of targeted.warnings) warnings.push(w);
        const newHits = targeted.hits.filter((h) => !allChunkIds.has(h.chunkId));
        if (newHits.length > 0) {
          kwHits = kwHits.concat(newHits);
          for (const h of newHits) {
            allChunkIds.add(h.chunkId);
            targetedChunkIds.add(h.chunkId);
          }
          idsList = Array.from(allChunkIds);
          secondPass = Object.freeze({
            triggered: true,
            kind: "targeted",
            reason: `partial coverage ${poolCoverage.idfWeightedCoverage.toFixed(2)} < ${COMPLETENESS_COMPLETE_THRESHOLD}; targeted retry on uncovered rare terms: ${plan.terms.join(", ")}`,
            added: newHits.length,
            targetedTerms: plan.terms,
          });
        }
      }
    }

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
    // when explicit event time exists. The `validityWindowFor` resolver
    // is hoisted above (shared with the targeted-retry coverage gate); an
    // unparseable declared value warns once and falls back to mtime.
    if (timeRange !== null) {
      const warnedInvalid = new Set<string>();
      const windowFor = validityWindowFor;
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
            const meta = readCachedFrontmatter(frontmatterCache, config.vault, path);
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
    // Cache note: like the tier signal, the stamp is read from
    // frontmatter at query time and is NOT part of the query-cache key;
    // a dream re-stamp reaches cached queries on the next reindex (the
    // content change bumps the corpus generation).
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
          const meta = readCachedFrontmatter(frontmatterCache, config.vault, h.path);
          const trend = parseFreshnessTrend((meta as Record<string, unknown>)["freshness_trend"]);
          if (trend !== null) byDoc.set(h.documentId, trend);
        } catch {
          // Unreadable frontmatter stays neutral.
        }
      }
      if (byDoc.size > 0) trendByDoc = byDoc;
    }

    // Observed-reuse boost (t_65588d8b): fold the session-end USED/IGNORED/
    // CONTRADICTED verdicts into a per-document reuse score and map it onto
    // each candidate chunk. Keyed by path (else id) to match how verdicts
    // are recorded. Empty (byte-identical) when no verdicts exist.
    let reuseRateByChunk: ReadonlyMap<number, number> | undefined;
    {
      const reuse = observedReuseRates(config.vault);
      if (reuse.size > 0) {
        const byChunk = new Map<number, number>();
        for (const chunkId of idsList) {
          const h = hydrated.get(chunkId);
          if (h === undefined) continue;
          const entry = reuse.get(h.path) ?? reuse.get(`${h.documentId}:${chunkId}`);
          if (entry !== undefined && entry.score > 0) byChunk.set(chunkId, entry.score);
        }
        if (byChunk.size > 0) reuseRateByChunk = byChunk;
      }
    }

    // When a property filter is active, overfetch the ranked
    // candidates so the post-filter result set still has a chance
    // of producing `limit` matching rows. Without this, the
    // top-`limit` ranked hits can lose all their property-matching
    // candidates to the filter and surface zero results even when
    // matches exist deeper in the rank.
    const hasPropertyFilter = opts.properties !== undefined && opts.properties.size > 0;
    // Graph-degree cardinality predicates (t_9bee8f0b): a post-rank filter
    // that can drop ranked rows, so it shares the frontmatter-filter
    // overfetch. Absent / empty leaves the pool and results byte-identical.
    const degreeFilters = opts.degreeFilters ?? [];
    const hasDegreeFilter = degreeFilters.length > 0;
    // An explicit visibility scope can also drop ranked rows, so it
    // shares the property filter's overfetch. The default (no scope)
    // path does NOT overfetch up front - all-untagged vaults stay
    // byte-identical to prior behaviour - and instead relies on the
    // one-shot backfill below when tagged pages actually shrink the
    // window.
    const visibilityScope = normalizeVisibilityScope(opts.visibility ?? []);
    const hasVisibilityRequest = (opts.visibility?.length ?? 0) > 0;
    // Agent-ownership scope (Unit 5): null means "no scope requested" -
    // no ownership filtering, so untagged vaults stay byte-identical.
    const agentScope = normalizeAgentScope(opts.agentScope);
    const hasAgentScopeRequest = agentScope !== null;
    // Composite scope filter (t_37c05a34): session/project axes on top of
    // owner. Null when no axis is requested, so an omitted filter never
    // narrows the pool (byte-identical default).
    const scopeFilter = opts.scope !== undefined ? normalizeScopeFilter(opts.scope) : null;
    const hasScopeRequest =
      scopeFilter !== null && (scopeFilter.session !== null || scopeFilter.project !== null);
    const hasFrontmatterFilter =
      hasPropertyFilter ||
      hasVisibilityRequest ||
      hasAgentScopeRequest ||
      hasScopeRequest ||
      hasDegreeFilter;

    // MMR and traversal both need a candidate pool wider than `limit`:
    // MMR diversifies from it, and traversal seeds expansion from it (a
    // narrow pool lets a high-parent expansion crowd a genuine but
    // lower-ranked hit out of the final window). When both are disabled
    // the pool collapses back to the historical rankLimit.
    const hasStructuredExclusions = (structured?.lex.exclude.length ?? 0) > 0;
    const mmrLambda = opts.mmrLambda ?? config.recall.mmrLambda;
    const mmrActive = mmrLambda < 1;
    // Relevance floor + rerank (Search & Recall Quality Suite). The floor
    // drops sub-threshold candidates before the diversity rerank so a
    // query with no sufficiently relevant memory returns no match; the
    // rerank re-orders the qualified set by core textual relevance. Both
    // off by default keep results byte-identical.
    const scoreFloor = opts.threshold ?? 0;
    const rerankActive = opts.rerank === true;
    // Cross-encoder rerank (retrieval-precision-quality-loop, card A): the
    // learned final reader step re-scores the top-K fused candidates. When
    // it is on, the candidate pool must be at least `top_k` wide so a
    // genuinely-relevant hit the heuristic ranker placed deep can be pulled
    // into the final window. Off by default keeps the pool byte-identical.
    const crossEncoderActive = config.rerank.enabled;
    const maxHops = opts.maxHops ?? config.recall.maxHops;
    const traversalActive = maxHops > 0;
    const baseRankLimit =
      hasFrontmatterFilter || hasStructuredExclusions ? semanticPoolSize(limit) : limit;
    const rankLimit =
      mmrActive || traversalActive || crossEncoderActive
        ? Math.max(baseRankLimit, limit * 3, 30, crossEncoderActive ? config.rerank.topK : 0)
        : baseRankLimit;

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
          ...(reuseRateByChunk !== undefined ? { reuseRateByChunk } : {}),
          ...(relationalRankedChunkIds.length > 0 ? { relationalRankedChunkIds } : {}),
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
      // Retrieval-time staleness barrier (t_b0c9d0a3): drop any exact-state
      // lane artifact a stale/older index may still hold, before any later
      // phase can surface it. No-op (same reference) when the pool has none,
      // so a vault that never used the lane is byte-identical.
      ranked = applyExactStateBarrier(ranked).slice();
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
        // Temporal bridge (t_c3871f0c): with an active time range,
        // traversal expansions must stay within a padded event-time
        // neighbourhood of the window - linked causes/consequences
        // bridge in with proximity-decayed scores, arbitrary old
        // neighbours do not. Event time = validity start, else mtime.
        if (timeRange !== null) {
          ranked = applyTemporalBridge(ranked, {
            range: timeRange,
            eventTimeMs: (path) => {
              const w = validityWindowFor(path);
              if (w !== null && !w.invalid && (w.validFromMs !== null || w.validUntilMs !== null)) {
                return w.validFromMs ?? w.validUntilMs!;
              }
              try {
                return statSync(join(config.vault, path)).mtimeMs;
              } catch {
                return Number.NEGATIVE_INFINITY;
              }
            },
          });
        }
      }
      // Relevance floor (Search & Recall Quality Suite): drop
      // sub-threshold candidates BEFORE diversity so the rerank works over
      // the qualified set only. No-op when the floor is 0.
      if (scoreFloor > 0) {
        ranked = ranked.filter((r) => r.score >= scoreFloor);
      }
      // Diversity rerank (v0.13.0). No-op when lambda >= 1 or < 2 results.
      if (mmrActive) {
        ranked = mmrRerank(ranked, { lambda: mmrLambda });
      }
      // Relevance rerank (Search & Recall Quality Suite): re-order the
      // qualified set by core textual relevance, a deeper-relevance second
      // pass. Opt-in; replaces the diversity ordering when requested.
      if (rerankActive) {
        ranked = rerankByRelevance(ranked).slice();
      }
      // Optional post-rank property filter (v0.10.17). Reads each
      // result's source frontmatter and drops rows whose scalars do not
      // match the requested key/value pairs, then visibility scoping (v3)
      // drops pages outside the requested visibility scope. Caching by
      // document path bounds the read cost to the result set.
      // Belief lifecycle suite (t_7d5a3589): drop tombstoned (incl.
      // superseded-non-tip) memories before any other post-rank stage.
      // A vault with no tombstoned entries passes through unchanged.
      const statusFiltered = applyStatusFilter(ranked, config.vault, frontmatterCache);
      const propFiltered = hasPropertyFilter
        ? applyPropertyFilter(statusFiltered, opts.properties!, config.vault, frontmatterCache)
        : statusFiltered;
      // Graph-degree cardinality predicates (t_9bee8f0b): drop rows whose
      // backlink/outlink counts fail the predicates, backed by the
      // link-graph degree index. No-op when no predicate was requested.
      const degreeFiltered = hasDegreeFilter
        ? applyDegreeFilter(propFiltered, degreeFilters, store)
        : propFiltered;
      const visible = applyVisibilityScope(
        degreeFiltered,
        visibilityScope,
        config.vault,
        frontmatterCache,
      );
      // Agent-ownership isolation (Unit 5): only when a scope is requested;
      // a null scope skips the filter entirely (byte-identical default).
      const scoped =
        agentScope !== null
          ? applyAgentScope(visible, agentScope, config.vault, frontmatterCache)
          : visible;
      // Composite session/project scope filter (t_37c05a34): applied only
      // when an axis is requested; a null filter skips it entirely so the
      // default path is byte-identical.
      const compositeScoped = hasScopeRequest
        ? applyScopeFilter(scoped, scopeFilter!, config.vault, frontmatterCache)
        : scoped;
      return { preVisibility: degreeFiltered.length, visible: compositeScoped, capHit };
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
      const wideCap = Math.max(semanticPoolSize(limit), limit * 3, 30);
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
    // Self-tuning reinforce (Search & Recall Quality Suite): opt-in. When
    // the caller passes a reinforce set, the persisted ledger lifts
    // proven-useful memories by a bounded boost BEFORE the top_k cut, so
    // a reinforced hit can enter the window. Absent leaves the pool
    // untouched; an empty ledger is a no-op either way.
    const reinforced =
      opts.reinforce !== undefined
        ? applyReinforceBoost(polarized, loadReinforceStrengths(config.vault))
        : polarized;
    // Cross-encoder rerank (retrieval-precision-quality-loop, card A): the
    // final reader step, appended AFTER every heuristic rerank. Disabled
    // (default) returns the pool unchanged (byte-identical); enabled but
    // unconfigured throws a typed config error; enabled + a request-time
    // endpoint error degrades to the heuristic ordering and records one
    // fail-open telemetry warning. Runs over the widened pool so a deep
    // candidate can be promoted into the final `limit` window below.
    const reranked = await applyCrossEncoderRerank(reinforced, query, config.rerank, {
      onTelemetry: (event) =>
        emitGatedTelemetry(event.status === "error", () => {
          warnings.push(`rerank_degraded: ${event.reason ?? "endpoint error"}`);
        }),
    });
    // Kernel 1 (t_5f61130a): the deterministic rank-adjustment sink between
    // ranking and result emission, mounted on BOTH the semantic and the
    // pure-lexical paths (both flow through this single pre-slice pool).
    // Registered adjusters return a per-candidate verdict; with none
    // registered the pool is returned unchanged, so the default path is
    // byte-identical. Runs BEFORE the slice so a gate exclusion lets a
    // deeper survivor backfill the window rather than shrinking it.
    const rankAdjusters: RankAdjuster[] = [];
    if (config.recall.retrievalTrustGateEnabled) {
      rankAdjusters.push(
        trustGateAdjuster((path) => readCachedFrontmatter(frontmatterCache, config.vault, path)),
      );
    }
    if (config.recall.supersedeFadeEnabled) {
      // Relation-only supersede fade (t_c4a9cef8): fetch the pool's typed
      // relations once and fade any candidate a `superseded_by` edge marks
      // superseded, the same source of truth `attachTrustMetadata` uses.
      const poolDocIds = Array.from(new Set(reranked.map((r) => r.documentId)));
      const relByPoolDoc = store.typedRelationsForDocuments(poolDocIds);
      rankAdjusters.push(supersedeFadeAdjuster((documentId) => relByPoolDoc.get(documentId) ?? []));
    }
    const adjusted = applyRankAdjusters(reranked, rankAdjusters);
    // Per-pack retrieval trust receipts (t_5f61130a): compact references
    // consistent with the context-receipt model. Built only when the gate
    // ran, so the outcome shape stays byte-identical on the default path.
    const trustReceipts = config.recall.retrievalTrustGateEnabled
      ? {
          retrievalDecisionTrace: buildRetrievalDecisionTrace({
            surfaced: adjusted.results.length,
            excluded: adjusted.excluded,
          }),
          memoryTrustAssessment: buildMemoryTrustAssessment({
            surfaced: adjusted.results.length,
            excluded: adjusted.excluded,
          }),
        }
      : null;
    const sliced = adjusted.results.slice(0, limit);
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
    // Two-pass attribution (t_ef92dfdc; targeted retry t_8eb5ca32): a
    // surfaced result of a retry says so - the operator can tell
    // recovered evidence from a first-pass hit. The broadened retry
    // replaced the whole pool, so every result is recovered; the
    // targeted retry only ADDED candidates, so only those (tracked in
    // `targetedChunkIds`) carry the reason - the first-pass hits they
    // merge with do not.
    const withSecondPassReasons =
      secondPass === undefined
        ? withCanonicalReasons
        : withCanonicalReasons.map((r) => {
            if (secondPass.kind === "targeted" && !targetedChunkIds.has(r.chunkId)) return r;
            const reason =
              secondPass.kind === "targeted"
                ? "second_pass: targeted retry on uncovered rare terms"
                : "second_pass: or-broadened retry";
            return Object.freeze({ ...r, reasons: Object.freeze([...r.reasons, reason]) });
          });
    // Relational-arm attribution (t_09b7ccea): a node surfaced by the
    // typed-edge fan-out carries a reason naming the link types and hop
    // distance it was reached by. Empty relationalMeta (arm off) is a no-op.
    const withRelationalReasons =
      relationalMeta.size === 0
        ? withSecondPassReasons
        : withSecondPassReasons.map((r) => {
            const meta = relationalMeta.get(r.chunkId);
            if (meta === undefined) return r;
            const reason = `relational: via ${meta.via.join(", ")} (${meta.hops} hop${meta.hops === 1 ? "" : "s"})`;
            return Object.freeze({ ...r, reasons: Object.freeze([...r.reasons, reason]) });
          });
    // Terminal-state downrank (recall-trust-suite) is now structural and
    // language-agnostic: a result is terminal when its frontmatter
    // `status:` field declares a terminal value (controlled vocabulary),
    // never because the note's prose happens to contain an English word
    // like "done". One cached frontmatter read per candidate path, only
    // in evidence-pack mode.
    const terminalPaths =
      opts.evidencePack === true
        ? buildTerminalPaths(config.vault, withRelationalReasons, frontmatterCache)
        : new Set<string>();
    const finalResults =
      opts.evidencePack === true
        ? downrankTerminalEvidenceResults(withRelationalReasons, terminalPaths)
        : withRelationalReasons;
    const evidencePack =
      opts.evidencePack === true
        ? buildEvidencePack(
            query,
            finalResults,
            buildEvidenceVerification(store, query, finalResults, pathPrefix),
            terminalPaths,
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

    // Inline trust metadata (Search & Recall Quality Suite): opt-in,
    // computed at read time from the document mtime and the surfaced
    // typed relations, never stored. Off by default keeps the result
    // shape byte-identical.
    const resultsOut =
      opts.trust === true ? attachTrustMetadata(config.vault, finalResults) : finalResults;

    // Progressive disclosure (D3): layer 1. When the caller opts into
    // `cards`, project the SAME ranked rows into token-cheap cards and
    // return them on `cards` with an empty `results`. The ranking,
    // filtering, and evidence pack are computed identically to full mode -
    // only the surfaced depth differs - so the contract stays
    // deterministic and the default `full` path is byte-identical.
    if ((opts.disclosure ?? "full") === "cards") {
      const cards = resultsOut.map(toSearchCard);
      return finalize(
        Object.freeze({
          results: Object.freeze([] as ReadonlyArray<BrainSearchResult>),
          cards: Object.freeze(cards),
          warnings: Object.freeze(warnings),
          total: cards.length,
          ...(evidencePack !== undefined ? { evidencePack } : {}),
          ...(secondPass !== undefined ? { secondPass } : {}),
          ...trustReceipts,
        }),
      );
    }

    return finalize(
      Object.freeze({
        results: Object.freeze(resultsOut),
        warnings: Object.freeze(warnings),
        total: resultsOut.length,
        ...(evidencePack !== undefined ? { evidencePack } : {}),
        ...(secondPass !== undefined ? { secondPass } : {}),
        ...trustReceipts,
      }),
    );
  } finally {
    await store.close();
  }
}

/** A token in at least this share of the corpus is treated as common. */
const COMMON_TOKEN_CORPUS_SHARE = 0.5;
/**
 * Floor on document frequency before a token can be "common". Below this
 * a corpus is too small to tell a stopword-like word from a rare one, so
 * nothing is flagged (a 2-document vault must not call a word that appears
 * once "ubiquitous").
 */
const MIN_COMMON_DOCUMENT_FREQUENCY = 2;

/**
 * Corpus-common query tokens, derived from document frequency. A token
 * present in at least {@link COMMON_TOKEN_CORPUS_SHARE} of the indexed
 * documents (and in at least {@link MIN_COMMON_DOCUMENT_FREQUENCY} of
 * them) carries little discriminating signal - in ANY language - so the
 * lex expansion lane drops it rather than letting one ubiquitous word
 * kill an implicit-AND match. Language-agnostic: no stopword list.
 *
 * Note: document frequency is measured through the FTS index, whose
 * tokenization can differ slightly from `tokenizeForExpansion`. A miss
 * only fails to flag a token as common (it stays in the lex lane), so the
 * fallback is always the safe, non-lossy direction.
 */
/** Bounded typed-edge fan-out depth for the relational arm (t_09b7ccea). */
const RELATIONAL_MAX_DEPTH = 2;

/**
 * The recognised edge-type vocabulary for the relational parser: the schema
 * pack's declared link types unioned with the default relation vocabulary,
 * all normalized. An unreadable pack falls back to the defaults. This is the
 * only place edge-type vocabulary enters the search path - never a
 * natural-language word list.
 */
function relationalEdgeVocabulary(vault: string): string[] {
  const vocab = new Set<string>(DEFAULT_RELATION_TYPES.map((t) => normalizeRelation(t)));
  try {
    for (const t of loadSchemaPack(vault).link_types) vocab.add(normalizeRelation(t));
  } catch {
    // An unreadable schema pack falls back to the default relation vocabulary.
  }
  return [...vocab];
}

/**
 * Resolve relational-query wikilink seeds to document ids. Tries the exact
 * `<seed>.md` path, then the bare seed, then an UNAMBIGUOUS basename match
 * anywhere in the tree (an ambiguous basename stays unresolved -
 * deterministic inertness beats guessing the wrong page). Deduped.
 */
function resolveSeedDocumentIds(store: Store, seeds: ReadonlyArray<string>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let titles: Map<number, { readonly path: string; readonly title: string | null }> | null = null;
  for (const seed of seeds) {
    let docId = store.getDocumentIdByPath(`${seed}.md`) ?? store.getDocumentIdByPath(seed);
    if (docId === null) {
      titles ??= store.documentTitles();
      const matches: number[] = [];
      for (const [id, meta] of titles) {
        const base = meta.path.split("/").pop() ?? meta.path;
        if (base === `${seed}.md`) matches.push(id);
      }
      if (matches.length === 1) docId = matches[0]!;
    }
    if (docId !== null && !seen.has(docId)) {
      seen.add(docId);
      out.push(docId);
    }
  }
  return out;
}

function highFrequencyTokens(store: Store, query: string): ReadonlySet<string> {
  const tokens = [...new Set(tokenizeForExpansion(query))];
  if (tokens.length === 0) return new Set();
  const documentCount = store.counts().documents;
  if (documentCount === 0) return new Set();
  const threshold = COMMON_TOKEN_CORPUS_SHARE * documentCount;
  const df = store.documentFrequencies(tokens);
  const common = new Set<string>();
  for (const token of tokens) {
    const freq = df.get(token) ?? 0;
    if (freq >= MIN_COMMON_DOCUMENT_FREQUENCY && freq >= threshold) common.add(token);
  }
  return common;
}
