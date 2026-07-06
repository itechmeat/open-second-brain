/**
 * Public surface for `src/core/search/*`: config resolution plus the
 * index/search/status/check entry points used by CLI and MCP layers.
 */

import { discoverConfig } from "../config.ts";
import {
  envOrConfig,
  parseBool as parseBoolShared,
  parseFloat01 as parseFloat01Shared,
  parseInteger as parseIntegerShared,
} from "../validate.ts";
import { resolveVaultScope } from "../vault-scope/index.ts";
import { resolveIndexPath } from "./paths.ts";
import { isFusionMode, DEFAULT_RRF_K } from "./fusion.ts";
import {
  loadProviderRegistry,
  expandRegisteredProvider,
  type ExpandedProvider,
} from "./embeddings/registry.ts";
import { loadRerankRegistry, expandRegisteredRerankProvider } from "./rerank/registry.ts";
import { SearchError } from "./types.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedRecallConfig,
  ResolvedRerankConfig,
  ResolvedSearchConfig,
  VaultIgnoreRule,
} from "./types.ts";

type SearchConfigOverrides = Partial<
  Omit<ResolvedSearchConfig, "ignoreRules" | "semantic" | "rerank">
> & {
  readonly ignoreRules?: ReadonlyArray<VaultIgnoreRule>;
  readonly semantic?: Partial<ResolvedEmbeddingConfig>;
  readonly rerank?: Partial<ResolvedRerankConfig>;
};

export type {
  BrainSearchResult,
  DisclosureMode,
  ExpandedNote,
  ExpandedRawChunk,
  ExpandHitInput,
  ExpandHitResult,
  IndexCheckReport,
  IndexStats,
  IndexStatusSnapshot,
  ResolvedEmbeddingConfig,
  ResolvedRecallConfig,
  ResolvedRerankConfig,
  ResolvedSearchConfig,
  SearchCard,
  SearchErrorCode,
  SearchOptions,
  SearchOutcome,
  VaultIgnoreRule,
} from "./types.ts";
export { SearchError, SEARCH_ERROR_CODES } from "./types.ts";
export {
  parseStructuredRecallQueryDocument,
  structuredRecallQueryText,
  type StructuredRecallQueryDocument,
} from "./structured-query.ts";
export {
  clearSessionFocus,
  normalizeSessionFocus,
  readSessionFocus,
  sessionFocusIsActive,
  writeSessionFocus,
  type SearchSessionFocus,
} from "./session-focus.ts";
export { evaluateSurfacingGate, type SurfacingGateDecision } from "./surfacing-gate.ts";
export { buildEvidencePack, serializeEvidencePack, type EvidencePack } from "./evidence-pack.ts";
export { serializeSearchCard, serializeIndexStatus } from "./serialize.ts";
export {
  loadProviderRegistry,
  addProviderProfile,
  removeProviderProfile,
  getProviderProfile,
  providerRegistryPath,
  RESERVED_PROVIDER_NAMES,
  type ProviderProfile,
} from "./embeddings/registry.ts";
export {
  loadRerankRegistry,
  addRerankProviderProfile,
  removeRerankProviderProfile,
  getRerankProviderProfile,
  rerankRegistryPath,
  type RerankProviderProfile,
} from "./rerank/registry.ts";
export {
  applyCrossEncoderRerank,
  type ApplyCrossEncoderRerankOptions,
  type RerankTelemetryEvent,
} from "./rerank/index.ts";

export { resolveIndexPath } from "./paths.ts";
export {
  indexVault,
  reindexVault,
  indexStatus,
  indexCheck,
  type IndexVaultOptions,
  type IndexProgressEvent,
} from "./indexer.ts";
export { search, expandHit, SEARCH_LIMIT_MIN, SEARCH_LIMIT_MAX } from "./search.ts";
export {
  captureRecallFeedback,
  computeLearnedWeights,
  feedbackDir,
  learnedWeightsPath,
  loadFeedbackEvents,
  readLearnedWeights,
  resetLearnedWeights,
  LEARNED_WEIGHT_MIN,
  LEARNED_WEIGHT_MAX,
  type LearnedWeights,
  type RecallFeedbackEvent,
} from "./feedback.ts";

const DEFAULTS = {
  chunkSize: 800,
  chunkOverlap: 100,
  chunkMinSize: 100,
  keywordWeight: 0.6,
  semanticWeight: 0.4,
  provider: "openai-compat" as const,
  timeoutMs: 10_000,
  concurrency: 4,
  batchSize: 32,
  costGateUsd: 0,
  mmrLambda: 0.7,
  maxHops: 1,
  hopDecay: 0.5,
  maxExpansionPerHit: 3,
  recencyShape: 0.8,
  recencyScale: 30,
  recencyAmplitude: 0.05,
  synonymMaxTerms: 3,
  cacheTtlSeconds: 300,
  fusionMode: "linear" as const,
  rrfK: DEFAULT_RRF_K,
  shutdownGraceSeconds: 5,
  resumeReindex: false,
  chainStopScore: 0.8,
  rerankTopK: 20,
  rerankMinScore: 0,
};

function parseFusionMode(raw: string | null): "linear" | "rrf" {
  if (raw === null) return DEFAULTS.fusionMode;
  if (isFusionMode(raw)) return raw;
  throw new SearchError(
    "INVALID_INPUT",
    `search_fusion_mode must be 'linear' or 'rrf', got '${raw}'`,
  );
}

type IntegerRange = { readonly min?: number; readonly max?: number };

function parseInteger(
  raw: string | null,
  fallback: number,
  fieldName: string,
  range?: IntegerRange,
): number {
  try {
    return parseIntegerShared(raw, fallback, fieldName, range);
  } catch (e) {
    throw new SearchError("INVALID_INPUT", (e as Error).message);
  }
}

function parseFloat01(raw: string | null, fallback: number, fieldName: string): number {
  try {
    return parseFloat01Shared(raw, fallback, fieldName);
  } catch (e) {
    throw new SearchError("INVALID_INPUT", (e as Error).message);
  }
}

function parseBool(raw: string | null, fallback: boolean, fieldName: string): boolean {
  try {
    return parseBoolShared(raw, fallback, fieldName);
  } catch (e) {
    throw new SearchError("INVALID_INPUT", (e as Error).message);
  }
}

/** Parse a strictly-positive finite float (e.g. Weibull shape / scale). */
function parsePositiveFloat(raw: string | null, fallback: number, fieldName: string): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be a number > 0, got '${raw}'`);
  }
  return n;
}

/** Parse a non-negative finite float (e.g. a cost gate; 0 disables). */
function parseNonNegativeFloat(raw: string | null, fallback: number, fieldName: string): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be a number >= 0, got '${raw}'`);
  }
  return n;
}

/**
 * Parse a finite float over the whole real line (e.g. a rerank floor,
 * which can be negative for backends that emit logits rather than [0, 1]
 * relevance).
 */
function parseFiniteFloat(raw: string | null, fallback: number, fieldName: string): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be a finite number, got '${raw}'`);
  }
  return n;
}

function validateIntegerRange(n: number, fieldName: string, range?: IntegerRange): void {
  // NaN/Infinity fail every `<`/`>` comparison below, so without this guard
  // an override supplied as a raw (non-string) number silently passes range
  // checks that a string-sourced value would have caught via parseInteger.
  if (!Number.isFinite(n)) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be a finite number, got '${n}'`);
  }
  if (range?.min !== undefined && n < range.min) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be >= ${range.min}, got ${n}`);
  }
  if (range?.max !== undefined && n > range.max) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be <= ${range.max}, got ${n}`);
  }
}

function validateWeight(n: number, fieldName: string): void {
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be a number in [0, 1], got '${n}'`);
  }
}

function validateResolvedConfig(config: ResolvedSearchConfig): void {
  validateIntegerRange(config.chunkSize, "search_chunk_size", { min: 1 });
  validateIntegerRange(config.chunkOverlap, "search_chunk_overlap", { min: 0 });
  if (config.chunkOverlap >= config.chunkSize) {
    throw new SearchError(
      "INVALID_INPUT",
      `search_chunk_overlap must be smaller than search_chunk_size, got ${config.chunkOverlap} >= ${config.chunkSize}`,
    );
  }
  validateIntegerRange(config.chunkMinSize, "search_chunk_min_size", { min: 1 });
  if (config.chunkMinSize > config.chunkSize) {
    throw new SearchError(
      "INVALID_INPUT",
      `search_chunk_min_size must not exceed search_chunk_size, got ${config.chunkMinSize} > ${config.chunkSize}`,
    );
  }
  validateWeight(config.keywordWeight, "search_keyword_weight");
  validateWeight(config.semanticWeight, "search_semantic_weight");
  if (config.keywordWeight + config.semanticWeight > 1.0 + 1e-9) {
    throw new SearchError(
      "INVALID_INPUT",
      `keyword_weight + semantic_weight must sum to <= 1, got ${config.keywordWeight} + ${config.semanticWeight}`,
    );
  }
  if (config.semantic.dimension !== null) {
    validateIntegerRange(config.semantic.dimension, "embedding_dimension", {
      min: 1,
    });
  }
  validateIntegerRange(config.semantic.timeoutMs, "embedding_timeout_ms", {
    min: 1,
  });
  validateIntegerRange(config.semantic.concurrency, "embedding_concurrency", {
    min: 1,
  });
  validateIntegerRange(config.semantic.batchSize, "embedding_batch_size", {
    min: 1,
  });
}

function parseProvider(raw: string | null): ResolvedEmbeddingConfig["provider"] {
  if (raw === null) return DEFAULTS.provider;
  if (raw === "openai-compat" || raw === "disabled" || raw === "local") return raw;
  throw new SearchError(
    "INVALID_INPUT",
    `embedding_provider must be 'openai-compat', 'local', 'disabled', or a registered provider name, got '${raw}'`,
  );
}

const BUILTIN_PROVIDERS: ReadonlySet<string> = new Set(["openai-compat", "disabled", "local"]);

/**
 * Resolve a non-built-in `embedding_provider` name against the registry.
 * Returns null when the name is null, a built-in, or not registered - the
 * caller then defers to `parseProvider` (which validates built-ins and
 * raises a clear error for an unknown name). Fail-soft: a bad registry
 * yields null, never an exception.
 */
function resolveRegistryProvider(
  rawProvider: string | null,
  vault: string,
  env: NodeJS.ProcessEnv,
): ExpandedProvider | null {
  if (rawProvider === null || BUILTIN_PROVIDERS.has(rawProvider)) return null;
  try {
    return expandRegisteredProvider(rawProvider, loadProviderRegistry(vault), env);
  } catch {
    return null;
  }
}

export function resolveSearchConfig(opts: {
  vault: string;
  configPath?: string;
  overrides?: SearchConfigOverrides;
}): ResolvedSearchConfig {
  const env = process.env;
  const config: Readonly<Record<string, string>> = opts.configPath
    ? discoverConfig(opts.configPath).data
    : {};

  const dbPath = resolveIndexPath(
    opts.vault,
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_DB", "search_db_path"),
  );

  const chunkSize = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_CHUNK_SIZE", "search_chunk_size"),
    DEFAULTS.chunkSize,
    "search_chunk_size",
    { min: 1 },
  );
  const chunkOverlap = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_CHUNK_OVERLAP", "search_chunk_overlap"),
    DEFAULTS.chunkOverlap,
    "search_chunk_overlap",
    { min: 0 },
  );
  const chunkMinSize = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_CHUNK_MIN_SIZE", "search_chunk_min_size"),
    DEFAULTS.chunkMinSize,
    "search_chunk_min_size",
    { min: 1 },
  );
  const keywordWeight = parseFloat01(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_KW_WEIGHT", "search_keyword_weight"),
    DEFAULTS.keywordWeight,
    "search_keyword_weight",
  );
  const semanticWeight = parseFloat01(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_SEM_WEIGHT", "search_semantic_weight"),
    DEFAULTS.semanticWeight,
    "search_semantic_weight",
  );
  const fusionMode = parseFusionMode(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_FUSION_MODE", "search_fusion_mode"),
  );
  const rrfK = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_RRF_K", "search_rrf_k"),
    DEFAULTS.rrfK,
    "search_rrf_k",
    { min: 1 },
  );

  // v0.10.9: single source of truth lives in Brain/_brain.yaml under
  // `vault.ignore_paths`. The legacy `search_ignore_paths` config key
  // and `OPEN_SECOND_BRAIN_SEARCH_IGNORE` env variable were removed.
  const scope = resolveVaultScope(opts.vault);
  const ignoreRules = scope.rules;

  const semanticEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC", "search_semantic_enabled"),
    false,
    "search_semantic_enabled",
  );
  const rawProvider = envOrConfig(
    env,
    config,
    "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
    "embedding_provider",
  );
  // A provider name that is not a built-in is looked up in the registry
  // AFTER the built-ins, so it never shadows an explicitly configured
  // built-in. A registered name resolves to openai-compat fields; an
  // unknown name falls through to parseProvider's clear validation error.
  const registryExpansion = resolveRegistryProvider(rawProvider, opts.vault, env);
  const provider = registryExpansion ? "openai-compat" : parseProvider(rawProvider);
  const explicitBaseUrl = envOrConfig(
    env,
    config,
    "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL",
    "embedding_base_url",
  );
  const explicitModel = envOrConfig(
    env,
    config,
    "OPEN_SECOND_BRAIN_EMBEDDING_MODEL",
    "embedding_model",
  );
  const explicitApiKey = envOrConfig(
    env,
    config,
    "OPEN_SECOND_BRAIN_EMBEDDING_KEY",
    "embedding_api_key",
  );
  // Explicit config/env always wins over the registry profile's fields.
  const baseUrl = explicitBaseUrl ?? registryExpansion?.baseUrl ?? null;
  const model = explicitModel ?? registryExpansion?.model ?? null;
  const apiKey = explicitApiKey ?? registryExpansion?.apiKey ?? null;
  const dimRaw = envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_DIM", "embedding_dimension");
  const dimension =
    dimRaw === null ? null : parseInteger(dimRaw, 0, "embedding_dimension", { min: 1 });
  const timeoutMs = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_TIMEOUT", "embedding_timeout_ms"),
    DEFAULTS.timeoutMs,
    "embedding_timeout_ms",
    { min: 1 },
  );
  const concurrency = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_CONCURRENCY", "embedding_concurrency"),
    DEFAULTS.concurrency,
    "embedding_concurrency",
    { min: 1 },
  );
  const batchSize = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_BATCH", "embedding_batch_size"),
    DEFAULTS.batchSize,
    "embedding_batch_size",
    { min: 1 },
  );
  const costGateUsd = parseNonNegativeFloat(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_COST_GATE", "embedding_cost_gate_usd"),
    DEFAULTS.costGateUsd,
    "embedding_cost_gate_usd",
  );

  const semantic: ResolvedEmbeddingConfig = Object.freeze({
    enabled: semanticEnabled,
    provider,
    baseUrl,
    model,
    apiKey,
    dimension,
    timeoutMs,
    concurrency,
    batchSize,
    costGateUsd,
  });

  // Cross-encoder rerank (retrieval-precision-quality-loop, card A). Off
  // by default; when off the reader tail is byte-identical. A registered
  // provider name (`search_rerank_provider`) supplies base_url / model /
  // env-key defaults; explicit `search_rerank_*` config/env always wins.
  const rerankEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_RERANK_ENABLED", "search_rerank_enabled"),
    false,
    "search_rerank_enabled",
  );
  const rerankProviderName = envOrConfig(
    env,
    config,
    "OPEN_SECOND_BRAIN_SEARCH_RERANK_PROVIDER",
    "search_rerank_provider",
  );
  const rerankProfile =
    rerankProviderName !== null
      ? expandRegisteredRerankProvider(rerankProviderName, loadRerankRegistry(opts.vault))
      : null;
  const rerankBaseUrl =
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_RERANK_BASE_URL",
      "search_rerank_base_url",
    ) ??
    rerankProfile?.baseUrl ??
    null;
  const rerankModel =
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_RERANK_MODEL", "search_rerank_model") ??
    rerankProfile?.model ??
    null;
  const rerankEnvKey =
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_RERANK_ENV_KEY", "search_rerank_env_key") ??
    rerankProfile?.envKey ??
    null;
  const rerankApiKey = rerankEnvKey !== null ? (env[rerankEnvKey] ?? null) : null;
  const rerankTopK = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_RERANK_TOP_K", "search_rerank_top_k"),
    DEFAULTS.rerankTopK,
    "search_rerank_top_k",
    { min: 1 },
  );
  const rerankMinScore = parseFiniteFloat(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_RERANK_MIN_SCORE",
      "search_rerank_min_score",
    ),
    DEFAULTS.rerankMinScore,
    "search_rerank_min_score",
  );
  const rerank: ResolvedRerankConfig = Object.freeze({
    enabled: rerankEnabled,
    baseUrl: rerankBaseUrl,
    model: rerankModel,
    envKey: rerankEnvKey,
    apiKey: rerankApiKey !== null && rerankApiKey !== "" ? rerankApiKey : null,
    topK: rerankTopK,
    minScore: rerankMinScore,
  });

  const mmrLambda = parseFloat01(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_MMR_LAMBDA", "search_mmr_lambda"),
    DEFAULTS.mmrLambda,
    "search_mmr_lambda",
  );
  const maxHops = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_MAX_HOPS", "search_max_hops"),
    DEFAULTS.maxHops,
    "search_max_hops",
    { min: 0 },
  );
  const hopDecay = parseFloat01(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_HOP_DECAY", "search_hop_decay"),
    DEFAULTS.hopDecay,
    "search_hop_decay",
  );
  const maxExpansionPerHit = parseInteger(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_MAX_EXPANSION_PER_HIT",
      "search_max_expansion_per_hit",
    ),
    DEFAULTS.maxExpansionPerHit,
    "search_max_expansion_per_hit",
    { min: 0 },
  );
  const recencyShape = parsePositiveFloat(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_RECENCY_SHAPE", "search_recency_shape"),
    DEFAULTS.recencyShape,
    "search_recency_shape",
  );
  const recencyScale = parsePositiveFloat(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_RECENCY_SCALE", "search_recency_scale"),
    DEFAULTS.recencyScale,
    "search_recency_scale",
  );
  const recencyAmplitude = parseFloat01(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_RECENCY_AMPLITUDE",
      "search_recency_amplitude",
    ),
    DEFAULTS.recencyAmplitude,
    "search_recency_amplitude",
  );
  const intentEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_INTENT_ENABLED", "search_intent_enabled"),
    true,
    "search_intent_enabled",
  );
  const synonymEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_SYNONYM_ENABLED", "search_synonym_enabled"),
    false,
    "search_synonym_enabled",
  );
  const synonymMaxTerms = parseInteger(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_SYNONYM_MAX_TERMS",
      "search_synonym_max_terms",
    ),
    DEFAULTS.synonymMaxTerms,
    "search_synonym_max_terms",
    { min: 0 },
  );
  const cacheEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_CACHE_ENABLED", "search_cache_enabled"),
    false,
    "search_cache_enabled",
  );
  const cacheTtlSeconds = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_CACHE_TTL", "search_cache_ttl_seconds"),
    DEFAULTS.cacheTtlSeconds,
    "search_cache_ttl_seconds",
    { min: 1 },
  );
  const relationPolarityEnabled = parseBool(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_RELATION_POLARITY",
      "search_relation_polarity_enabled",
    ),
    true,
    "search_relation_polarity_enabled",
  );
  const learnedWeightsEnabled = parseBool(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_LEARNED_WEIGHTS",
      "search_learned_weights_enabled",
    ),
    false,
    "search_learned_weights_enabled",
  );
  const activationEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_ACTIVATION", "search_activation_enabled"),
    true,
    "search_activation_enabled",
  );
  const twoPassEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_TWO_PASS", "search_two_pass_enabled"),
    true,
    "search_two_pass_enabled",
  );
  const poolMultiplier = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_POOL_MULTIPLIER", "search_pool_multiplier"),
    3,
    "search_pool_multiplier",
    { min: 1, max: 10 },
  );
  const selfTuningEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_SELF_TUNING", "search_self_tuning_enabled"),
    false,
    "search_self_tuning_enabled",
  );
  const chainStopEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_CHAIN_STOP", "search_chain_stop_enabled"),
    false,
    "search_chain_stop_enabled",
  );
  const chainStopScore = parseFloat01(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_CHAIN_STOP_SCORE",
      "search_chain_stop_score",
    ),
    DEFAULTS.chainStopScore,
    "search_chain_stop_score",
  );
  const shutdownGraceSeconds = parseInteger(
    envOrConfig(
      env,
      config,
      "OPEN_SECOND_BRAIN_SEARCH_SHUTDOWN_GRACE",
      "search_shutdown_grace_seconds",
    ),
    DEFAULTS.shutdownGraceSeconds,
    "search_shutdown_grace_seconds",
    { min: 0 },
  );
  const resumeReindex = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_RESUME_REINDEX", "search_resume_reindex"),
    DEFAULTS.resumeReindex,
    "search_resume_reindex",
  );
  const recall: ResolvedRecallConfig = Object.freeze({
    mmrLambda,
    maxHops,
    hopDecay,
    maxExpansionPerHit,
    recencyShape,
    recencyScale,
    recencyAmplitude,
    intentEnabled,
    synonymEnabled,
    synonymMaxTerms,
    cacheEnabled,
    cacheTtlSeconds,
    relationPolarityEnabled,
    learnedWeightsEnabled,
    activationEnabled,
    twoPassEnabled,
    poolMultiplier,
    selfTuningEnabled,
    chainStopEnabled,
    chainStopScore,
  });

  const base: ResolvedSearchConfig = Object.freeze({
    vault: opts.vault,
    dbPath,
    ignoreRules,
    chunkSize,
    chunkOverlap,
    chunkMinSize,
    keywordWeight,
    semanticWeight,
    fusionMode,
    rrfK,
    semantic,
    recall,
    rerank,
    shutdownGraceMs: shutdownGraceSeconds * 1000,
    resumeReindex,
  });

  if (!opts.overrides) {
    validateResolvedConfig(base);
    return base;
  }
  const merged = Object.freeze({
    ...base,
    ...opts.overrides,
    semantic: Object.freeze({ ...base.semantic, ...opts.overrides.semantic }),
    rerank: Object.freeze({ ...base.rerank, ...opts.overrides.rerank }),
    ignoreRules: opts.overrides.ignoreRules
      ? Object.freeze([...opts.overrides.ignoreRules])
      : base.ignoreRules,
  });
  validateResolvedConfig(merged);
  return merged;
}
