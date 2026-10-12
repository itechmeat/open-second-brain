/**
 * Persistent query-cache slot: which queries may be cached, what the row
 * is keyed by, and how a computed outcome is written back.
 *
 * The key composition is a compatibility surface: every previously cached
 * row was written under it, so any change to the fingerprint fields, their
 * order, or the suffix layout silently orphans the existing cache.
 */

import { canonicalSourceSetKey } from "../../scope-key.ts";
import { sha256Hex, canonicalJson } from "../../integrity/digest.ts";
import { activationStateFingerprint } from "../activation/store.ts";
import { effectiveInputWindowTokens, queryPrefixSentByProvider } from "../embeddings/presets.ts";
import { learnedWeightsFingerprint } from "../feedback.ts";
import { buildCacheKey, getCachedOutcome, putCachedOutcome } from "../query-cache.ts";
import { reinforceFingerprint } from "../reinforce.ts";
import { RERANK_SUNSET_SURVEY } from "../rerank/sunset.ts";
import { resolveIterativeMaxRounds } from "./iterative-recall.ts";
import type { Store } from "../store.ts";
import type { SemanticPolicy } from "../semantic-phase.ts";
import type { TemporalIntent } from "../temporal-intent.ts";
import type { ResolvedTimeRange } from "../time-range.ts";
import type {
  IterativeStopReason,
  ResolvedSearchConfig,
  SearchOptions,
  SearchOutcome,
  SearchSessionFocus,
  TunedParameters,
} from "../types.ts";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Cache-key suffix segments for the iterative recall round-trip
 * (recall-quality wave). Appended to the config fingerprint ONLY when
 * the iterative mode is actually on - the request flag AND the operator
 * knob - so plain rows keep their pre-wave keys byte-identical and only
 * mode-on rows (new by definition) use the extended layout. The plan
 * leg and the commit leg get distinct segments so a plan response can
 * never be served for a commit request or the reverse; the plan segment
 * also names the resolved round cap, because a plan row records the
 * round count it ran under and a raised cap must re-key, not replay.
 */
const ITERATIVE_KEY_PLAN = "itv:plan";
const ITERATIVE_KEY_COMMIT_PREFIX = "itv:commit:";
/** Hex chars of the payload digest kept in a commit key; a fingerprint, not an id. */
const ITERATIVE_PAYLOAD_DIGEST_CHARS = 16;
/**
 * Key prefix of the single-use round-token registry's mint rows (the
 * plan-phase record a commit validates against). The registry rides the
 * query-cache table BY DESIGN - one store, one generation gate - and it
 * deliberately borrows `search_cache_ttl_seconds` for its row expiry
 * even when `search_cache_enabled` is off: the knob gates the outcome
 * rows, not the table, and a token must die exactly when its plan-phase
 * outcome row dies, so the two legs can never disagree about how long a
 * plan's claim on a round survives.
 */
const ITERATIVE_TOKEN_KEY_PREFIX = "itv-token:";
/**
 * Key prefix of the claim rows: a commit's atomic single-use marker,
 * kept apart from the mint row so a failed round's release can restore
 * the retry state (the mint row - and the pause digest the retry
 * validates against - survives the release).
 */
const ITERATIVE_CLAIM_KEY_PREFIX = "itv-claim:";

/**
 * What a plan-phase mint persisted under the token's registry row: the
 * digest of the pause state (query, round, pool) the token was minted
 * over, plus the deterministic round count (and stop) the plan leg ran.
 * A commit recomputes the digest over its replayed state and refuses
 * unless the two agree, and it replays EXACTLY the recorded round count -
 * the replay's own marginal-value verdict and deadline read wall-clock
 * time and would retire rounds the plan ran, landing on a different
 * pause. `rounds`/`stopReason` are optional so a row written by a
 * just-deployed predecessor (no recording yet) still validates by digest.
 */
export interface IterativeTokenRecord {
  readonly pauseDigest: string;
  readonly rounds?: number;
  readonly stopReason?: IterativeStopReason;
}

/**
 * Whether the single-use round token has a spent claim in the query
 * cache. The registry rides the same table the outcome rows use - one
 * store, one generation gate, one TTL - so a token dies when its
 * plan-phase row dies, and a replayed commit is refused before any
 * cached commit response could be served. Only the claim row means
 * spent: a fresh mint row is a live, commitable token.
 */
export function iterativeTokenSpent(
  store: Store,
  config: ResolvedSearchConfig,
  token: string,
  nowMs: number = Date.now(),
): boolean {
  const row = store.queryCacheGet(`${ITERATIVE_CLAIM_KEY_PREFIX}${token}`);
  if (row === null) return false;
  if (row.generation !== store.corpusGeneration()) return false;
  return nowMs - row.createdAt <= config.recall.cacheTtlSeconds * MILLISECONDS_PER_SECOND;
}

/**
 * Register a plan-phase mint: file the pause digest and the recorded
 * deterministic round count under the nonce token so the commit can
 * validate its replayed state against the row and replay exactly that
 * many rounds. Insert-once - the token is fresh randomness, so a
 * conflict means a colliding mint, refused here. False (and a failed
 * write) tells the plan phase to fall back to the deterministic token:
 * the registry is best-effort, and a plan whose registry row never
 * landed hands out the self-verifying digest token instead of failing
 * the search.
 */
export function mintIterativeToken(
  store: Store,
  config: ResolvedSearchConfig,
  token: string,
  record: IterativeTokenRecord,
  nowMs: number = Date.now(),
): boolean {
  try {
    const generation = store.corpusGeneration();
    const ttlMs = config.recall.cacheTtlSeconds * MILLISECONDS_PER_SECOND;
    store.queryCacheSweep(generation, nowMs - ttlMs);
    return store.queryCachePutIfAbsent(
      `${ITERATIVE_TOKEN_KEY_PREFIX}${token}`,
      generation,
      JSON.stringify({ state: "minted", ...record }),
      nowMs,
    );
  } catch {
    // Registry persistence is best-effort; the plan falls back instead.
    return false;
  }
}

/**
 * Read what a fresh plan-phase mint stored for this token. Null when no
 * row stands behind the token - never minted, expired with its TTL, aged
 * out by a corpus generation change, or written under a payload this
 * binary cannot read - which sends the commit down the deterministic
 * re-derivation check. Best-effort by the same contract as the mint: a
 * registry read failure reads as no row.
 */
export function readIterativeTokenRecord(
  store: Store,
  config: ResolvedSearchConfig,
  token: string,
  nowMs: number = Date.now(),
): IterativeTokenRecord | null {
  try {
    const row = store.queryCacheGet(`${ITERATIVE_TOKEN_KEY_PREFIX}${token}`);
    if (row === null) return null;
    if (row.generation !== store.corpusGeneration()) return null;
    if (nowMs - row.createdAt > config.recall.cacheTtlSeconds * MILLISECONDS_PER_SECOND) {
      return null;
    }
    const parsed = JSON.parse(row.payload) as {
      state?: string;
      pauseDigest?: unknown;
      rounds?: unknown;
      stopReason?: unknown;
    };
    if (parsed.state !== "minted" || typeof parsed.pauseDigest !== "string") return null;
    return {
      pauseDigest: parsed.pauseDigest,
      ...(typeof parsed.rounds === "number" ? { rounds: parsed.rounds } : {}),
      ...(typeof parsed.stopReason === "string"
        ? { stopReason: parsed.stopReason as IterativeStopReason }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Claim a round token as spent in one atomic insert: the claim, not a
 * later check, arbitrates single use, so two commits racing on the same
 * token cannot both pass. The claim row is keyed apart from the mint
 * row, so a release (a commit whose round failed) restores the retry
 * state without losing the pause digest the retry revalidates against.
 * False means the token is already claimed in this generation inside
 * its TTL - the call site refuses that commit by name. The TTL is the
 * search cache's (`search_cache_ttl_seconds`), borrowed deliberately
 * even when search caching is off: the registry rides the query-cache
 * table so one generation gate and one expiry govern both legs, and a
 * claim never outlives the plan row it answers. The registry is
 * best-effort, and its two honest failure modes are: a failed write
 * costs a deterministic re-run of the same commit on replay (the
 * validator re-checks the token against the state), and the expiry
 * sliver - the claim row ages out before the commit response row - lets
 * a replay serve the live commit row without re-validation. Both are
 * bounded: the commit is retrieval-only and deterministic, never a
 * wrong answer.
 */
export function claimIterativeToken(
  store: Store,
  config: ResolvedSearchConfig,
  token: string,
  nowMs: number = Date.now(),
): boolean {
  try {
    const generation = store.corpusGeneration();
    const ttlMs = config.recall.cacheTtlSeconds * MILLISECONDS_PER_SECOND;
    store.queryCacheSweep(generation, nowMs - ttlMs);
    return store.queryCachePutIfAbsent(
      `${ITERATIVE_CLAIM_KEY_PREFIX}${token}`,
      generation,
      JSON.stringify({ state: "spent" }),
      nowMs,
    );
  } catch {
    // Registry persistence is best-effort; never fail a committed search on it.
    return true;
  }
}

/**
 * Release a claim this call made and can no longer honor: a commit whose
 * round failed keeps the retry semantics the post-execution mark had -
 * the caller may re-commit the same token (its mint row, and the pause
 * digest the retry validates against, are untouched) - while racing
 * commits stay mutually exclusive, because a release only ever removes
 * the claim row the failing call itself wrote.
 */
export function releaseIterativeToken(store: Store, token: string): void {
  try {
    store.queryCacheDelete(`${ITERATIVE_CLAIM_KEY_PREFIX}${token}`);
  } catch {
    // Release is best-effort; a stuck claim costs a fresh plan phase.
  }
}

/**
 * The suffix for one iterative mode-on request: `itv:plan:r<maxRounds>`
 * for the flag alone - the round cap is part of the key because a cached
 * plan row carries the recorded round count, so raising the cap must
 * re-key plans instead of serving one recorded under the old budget -
 * and `itv:commit:<token>:<payload digest>` for the commit leg - the
 * plan and commit phases are deterministic functions of their inputs
 * (vault, query, token, payload), so caching stays sound per leg.
 */
function iterativeCacheSuffix(config: ResolvedSearchConfig, opts: SearchOptions): string {
  if (opts.iterative !== true) return "";
  if (opts.iterativeToken === undefined) {
    return `|${ITERATIVE_KEY_PLAN}:r${resolveIterativeMaxRounds(config)}`;
  }
  const payloadDigest = sha256Hex(canonicalJson(opts.iterativePayload ?? null)).slice(
    0,
    ITERATIVE_PAYLOAD_DIGEST_CHARS,
  );
  return `|${ITERATIVE_KEY_COMMIT_PREFIX}${opts.iterativeToken}:${payloadDigest}`;
}

function iterativeModeOn(config: ResolvedSearchConfig, opts: SearchOptions): boolean {
  return opts.iterative === true && config.recall.iterativeRecallEnabled === true;
}

/**
 * What a decision-model rerank passage carries. Part of the decision-model
 * fingerprint only, so the keys of every other rerank kind are unchanged.
 */
const DECISION_RERANK_STATE_SHAPE = "passage:title,status,updated,text;skip:frontmatter";

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
    // An enabled openai-compat rerank skips a model once its surveyed
    // shutdown date has passed, and that skip answer is cached. The
    // survey's review date re-keys it, so a build that corrects a survey
    // row stops replaying the old verdict. Present only for that kind, so
    // every other key is unchanged.
    ...(config.rerank.enabled && config.rerank.kind === "openai-compat"
      ? { rrkSunset: RERANK_SUNSET_SURVEY.reviewedAt }
      : {}),
    // The decision-model kind: its mode decides whether the order changes.
    // Present only for that kind, so every other key is unchanged.
    ...(config.rerank.kind === "decision-model"
      ? {
          rrkKind: config.rerank.kind,
          // Route identity without the credential: provider, endpoint,
          // pinned model and mode each change what an enforced order is,
          // and so do the state budget (how many candidates are sent) and
          // the answerable mode (an extra question in the same request).
          // The last entry names what a passage carries (title, `status`,
          // `updated`, frontmatter-only chunks skipped): the model judges
          // those fields, so a change to that shape re-keys the order.
          rrkDm: [
            config.rerank.decisionModel?.provider ?? "",
            config.rerank.decisionModel?.baseUrl ?? "",
            config.rerank.decisionModel?.model ?? "",
            config.rerank.decisionModel?.uses.rerank ?? "off",
            String(config.rerank.decisionModel?.maxStateTokens ?? ""),
            config.rerank.decisionModel?.uses.answerable ?? "off",
            DECISION_RERANK_STATE_SHAPE,
          ].join("|"),
        }
      : {}),
    // Trigram prefilter augments the candidate pool, so a toggle or
    // selectivity change must invalidate cached rows.
    tri: r.trigramPrefilterEnabled,
    triMin: r.trigramPrefilterMinChunks,
    triSel: r.trigramPrefilterMaxSelectivity,
    // The query embed is fitted to the effective input window with the
    // instruction prefix the provider sends counted in, so either one
    // changes the text embedded (and whether it was cut): a declared or
    // changed window, or another prefix, re-keys the answer. Present only
    // with semantic search on, so every keyword-only key is unchanged.
    ...(config.semantic.enabled
      ? {
          qWin: effectiveInputWindowTokens(config.semantic),
          qPre: queryPrefixSentByProvider(config.semantic.provider, config.semantic.queryPrefix),
        }
      : {}),
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
      // The iterative fields join the suffix only when the mode is on,
      // so off-mode keys (and every pre-wave row) stay byte-identical.
      `${configFingerprint(config)}|lw:${lwFp}|act:${actFp}|tune:${tuneFp}|reinf:${reinfFp}|src:${srcSet}${iterativeModeOn(config, opts) ? iterativeCacheSuffix(config, opts) : ""}`,
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
