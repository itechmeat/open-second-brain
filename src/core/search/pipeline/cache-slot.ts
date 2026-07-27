/**
 * Persistent query-cache slot: which queries may be cached, what the row
 * is keyed by, and how a computed outcome is written back.
 *
 * The key composition is a compatibility surface: every previously cached
 * row was written under it, so any change to the fingerprint fields, their
 * order, or the suffix layout silently orphans the existing cache.
 */

import { canonicalSourceSetKey } from "../../scope-key.ts";
import { activationStateFingerprint } from "../activation/store.ts";
import { learnedWeightsFingerprint } from "../feedback.ts";
import { buildCacheKey, getCachedOutcome, putCachedOutcome } from "../query-cache.ts";
import { reinforceFingerprint } from "../reinforce.ts";
import type { Store } from "../store.ts";
import type { SemanticPolicy } from "../semantic-phase.ts";
import type { TemporalIntent } from "../temporal-intent.ts";
import type { ResolvedTimeRange } from "../time-range.ts";
import type {
  ResolvedSearchConfig,
  SearchOptions,
  SearchOutcome,
  SearchSessionFocus,
  TunedParameters,
} from "../types.ts";

const MILLISECONDS_PER_SECOND = 1000;

/** Fingerprint placeholder for a state source the query did not consult. */
const FINGERPRINT_OFF = "off";

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

/**
 * Whether this query may be served from - and written to - the cache.
 * A time-filtered query is excluded: a relative range ("24h") resolves to
 * a different absolute window on every call, so a cached row would serve a
 * stale window within the TTL. A window the QUERY declared (`since:24h`)
 * is the same hazard from the other direction: its resolved signature is
 * in the plan hash, so every call keys differently, never hits, and writes
 * one more row that can never be served. Both forms are excluded by the
 * one condition.
 */
export function isCacheEligible(
  config: ResolvedSearchConfig,
  timeRange: ResolvedTimeRange | null,
  temporalIntent: TemporalIntent | null,
): boolean {
  return config.recall.cacheEnabled && timeRange === null && temporalIntent === null;
}

export interface CacheSlot {
  readonly key: string;
  readonly generation: string;
  readonly ttlMs: number;
}

export interface CacheProbe {
  /** Null when the cache could not be reached; nothing is written back. */
  readonly slot: CacheSlot | null;
  readonly hit: SearchOutcome | null;
}

export interface CacheProbeInput {
  readonly store: Store;
  readonly config: ResolvedSearchConfig;
  readonly opts: SearchOptions;
  readonly limit: number;
  readonly policy: SemanticPolicy;
  readonly sessionFocus: SearchSessionFocus | null;
  readonly tuned: TunedParameters | null;
  readonly planHash: string;
}

/**
 * Look the query up in the persistent cache (v0.20.0). Keyed by the
 * request + base plan hash + a config fingerprint, gated by the corpus
 * generation and a TTL. Expansion terms are not in the key: they are
 * determined by (query, index content) and any content change bumps the
 * generation.
 *
 * The whole lookup is best-effort: any failure (e.g. a SQLITE_BUSY past
 * the busy_timeout under a concurrent reindex) yields an empty probe and
 * a fresh compute rather than breaking the search.
 */
export function probeQueryCache(input: CacheProbeInput): CacheProbe {
  const { store, config, opts, limit, policy, sessionFocus, tuned, planHash } = input;
  const ttlMs = config.recall.cacheTtlSeconds * MILLISECONDS_PER_SECOND;
  try {
    const generation = store.corpusGeneration();
    // Key on the EFFECTIVE request (clamped limit, resolved semantic
    // decision) so equivalent calls share a cache entry.
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
      : FINGERPRINT_OFF;
    // The activation state evolves with recorded accesses the same
    // way, so its fingerprint joins too (Time-Aware Recall Suite).
    const actFp = config.recall.activationEnabled
      ? activationStateFingerprint(config.vault)
      : FINGERPRINT_OFF;
    const tuneFp = tuned !== null ? JSON.stringify(tuned) : FINGERPRINT_OFF;
    // The reinforce ledger changes results only when the caller opted
    // in (Search & Recall Quality Suite); its fingerprint joins the
    // key just for those calls so an unrelated ledger write never
    // invalidates ordinary searches.
    const reinfFp =
      opts.reinforce !== undefined ? reinforceFingerprint(config.vault) : FINGERPRINT_OFF;
    // Federation hardening (t_09b7ccea): the query cache scopes by the
    // canonical source-set key, so a cache row is never served for a
    // different set of origins. Single-vault search draws from one
    // origin (this vault).
    const srcSet = canonicalSourceSetKey([config.vault]);
    const key = buildCacheKey(
      keyOpts,
      planHash,
      `${configFingerprint(config)}|lw:${lwFp}|act:${actFp}|tune:${tuneFp}|reinf:${reinfFp}|src:${srcSet}`,
    );
    const hit = getCachedOutcome(store, key, generation, ttlMs, Date.now());
    return { slot: { key, generation, ttlMs }, hit };
  } catch {
    return { slot: null, hit: null };
  }
}

/** Write the computed outcome back. Best-effort: never fails a search. */
export function persistCachedOutcome(store: Store, slot: CacheSlot, outcome: SearchOutcome): void {
  try {
    store.queryCacheSweep(slot.generation, Date.now() - slot.ttlMs);
    putCachedOutcome(store, slot.key, slot.generation, outcome, Date.now());
  } catch {
    // Cache persistence is best-effort; never fail a search on it.
  }
}
