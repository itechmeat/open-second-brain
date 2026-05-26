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

function validateIntegerRange(
  n: number,
  fieldName: string,
  range?: IntegerRange,
): void {
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
  const recall: ResolvedRecallConfig = Object.freeze({ mmrLambda });

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
    semantic: Object.freeze({ ...base.semantic, ...(opts.overrides.semantic ?? {}) }),
    ignoreRules: opts.overrides.ignoreRules
      ? Object.freeze([...opts.overrides.ignoreRules])
      : base.ignoreRules,
  });
  validateResolvedConfig(merged);
  return merged;
}
