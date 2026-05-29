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
import { SearchError } from "./types.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedRecallConfig,
  ResolvedSearchConfig,
  VaultIgnoreRule,
} from "./types.ts";

type SearchConfigOverrides = Partial<Omit<ResolvedSearchConfig, "ignoreRules" | "semantic">> & {
  readonly ignoreRules?: ReadonlyArray<VaultIgnoreRule>;
  readonly semantic?: Partial<ResolvedEmbeddingConfig>;
};

export type {
  BrainSearchResult,
  IndexCheckReport,
  IndexStats,
  IndexStatusSnapshot,
  ResolvedEmbeddingConfig,
  ResolvedRecallConfig,
  ResolvedSearchConfig,
  SearchErrorCode,
  SearchOptions,
  SearchOutcome,
  VaultIgnoreRule,
} from "./types.ts";
export { SearchError, SEARCH_ERROR_CODES } from "./types.ts";

export { resolveIndexPath } from "./paths.ts";
export {
  indexVault,
  reindexVault,
  indexStatus,
  indexCheck,
  type IndexVaultOptions,
  type IndexProgressEvent,
} from "./indexer.ts";
export { search } from "./search.ts";

const DEFAULTS = {
  chunkSize: 800,
  chunkOverlap: 100,
  keywordWeight: 0.6,
  semanticWeight: 0.4,
  provider: "openai-compat" as const,
  timeoutMs: 10_000,
  concurrency: 4,
  batchSize: 32,
  mmrLambda: 0.7,
  maxHops: 1,
  hopDecay: 0.5,
  maxExpansionPerHit: 3,
  recencyShape: 0.8,
  recencyScale: 30,
  recencyAmplitude: 0.05,
  synonymMaxTerms: 3,
  cacheTtlSeconds: 300,
};

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

function validateIntegerRange(n: number, fieldName: string, range?: IntegerRange): void {
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
  validateWeight(config.keywordWeight, "search_keyword_weight");
  validateWeight(config.semanticWeight, "search_semantic_weight");
  if (config.keywordWeight + config.semanticWeight > 1.0 + 1e-9) {
    throw new SearchError(
      "INVALID_INPUT",
      `keyword_weight + semantic_weight must sum to <= 1, got ${config.keywordWeight} + ${config.semanticWeight}`,
    );
  }
  if (config.semantic.dimension !== null) {
    validateIntegerRange(config.semantic.dimension, "embedding_dimension", { min: 1 });
  }
  validateIntegerRange(config.semantic.timeoutMs, "embedding_timeout_ms", { min: 1 });
  validateIntegerRange(config.semantic.concurrency, "embedding_concurrency", { min: 1 });
  validateIntegerRange(config.semantic.batchSize, "embedding_batch_size", { min: 1 });
}

function parseProvider(raw: string | null): ResolvedEmbeddingConfig["provider"] {
  if (raw === null) return DEFAULTS.provider;
  if (raw === "openai-compat" || raw === "disabled") return raw;
  throw new SearchError(
    "INVALID_INPUT",
    `embedding_provider must be 'openai-compat' or 'disabled', got '${raw}'`,
  );
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
  const provider = parseProvider(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER", "embedding_provider"),
  );
  const baseUrl = envOrConfig(
    env,
    config,
    "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL",
    "embedding_base_url",
  );
  const model = envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_MODEL", "embedding_model");
  const apiKey = envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_KEY", "embedding_api_key");
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
  });

  const base: ResolvedSearchConfig = Object.freeze({
    vault: opts.vault,
    dbPath,
    ignoreRules,
    chunkSize,
    chunkOverlap,
    keywordWeight,
    semanticWeight,
    semantic,
    recall,
  });

  if (!opts.overrides) {
    validateResolvedConfig(base);
    return base;
  }
  const merged = Object.freeze({
    ...base,
    ...opts.overrides,
    semantic: Object.freeze({ ...base.semantic, ...opts.overrides.semantic }),
    ignoreRules: opts.overrides.ignoreRules
      ? Object.freeze([...opts.overrides.ignoreRules])
      : base.ignoreRules,
  });
  validateResolvedConfig(merged);
  return merged;
}
