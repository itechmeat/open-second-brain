/**
 * Provider-resolution / no-op seam (semantic-retrieval-precision, parent
 * t_47fd9523).
 *
 * Two shared, dependency-light helpers modeled on `openai-compat.ts`'s
 * fail-closed-validation + graceful-no-op discipline:
 *
 *   - `resolveConfiguredEmbeddingProvider` resolves the vault's
 *     configured embedding provider, returning `null` (never throwing
 *     into the hot path) when semantic search is disabled or resolution
 *     fails. The entity semantic-dedup pass uses this for its cosine
 *     layer.
 *   - `resolveOpenAiCompatEndpoint` validates an OpenAI-compatible
 *     endpoint config (base_url + model + env-resolved api key) once,
 *     fail-closed when a feature is enabled but its endpoint is
 *     incomplete, and a graceful no-op (null) when the feature is off.
 *     This is THE SEAM the child cross-encoder rerank stage reuses so
 *     provider resolution is not re-implemented per feature.
 */

import { SearchError } from "../types.ts";

/** A fully-resolved OpenAI-compatible endpoint (base_url + model + key). */
export interface OpenAiCompatEndpoint {
  /** Base URL with trailing slashes stripped. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

/** Inputs to {@link resolveOpenAiCompatEndpoint}. */
export interface ResolveEndpointInput {
  /** Feature flag; when false the resolver is a graceful no-op. */
  readonly enabled: boolean;
  readonly baseUrl: string | null;
  readonly model: string | null;
  /** Env var NAME the api key is read from (looked up in `env`). */
  readonly envKey?: string | null;
  /** Directly-provided api key; wins over the `envKey` lookup. */
  readonly apiKey?: string | null;
  /** Environment map; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Resolve an OpenAI-compatible endpoint config, fail-closed. Returns
 * `null` when `enabled` is false (graceful no-op — zero cost, no
 * validation). When enabled, requires base_url, model, and a non-empty
 * api key (from `apiKey`, else `env[envKey]`), throwing a `SearchError`
 * with a `label`-prefixed message otherwise — the same discipline
 * `openai-compat.ts` applies when semantic is enabled without an
 * endpoint. `label` names the config family, e.g. `search_rerank`.
 */
export function resolveOpenAiCompatEndpoint(
  input: ResolveEndpointInput,
  label: string,
): OpenAiCompatEndpoint | null {
  if (!input.enabled) return null;

  const baseUrl = nonEmpty(input.baseUrl);
  if (baseUrl === null) {
    throw new SearchError(
      "INVALID_INPUT",
      `${label}_base_url is required when ${label} is enabled`,
    );
  }
  const model = nonEmpty(input.model);
  if (model === null) {
    throw new SearchError("INVALID_INPUT", `${label}_model is required when ${label} is enabled`);
  }

  const env = input.env ?? process.env;
  const direct = nonEmpty(input.apiKey);
  const fromEnv = input.envKey ? nonEmpty(env[input.envKey]) : null;
  const apiKey = direct ?? fromEnv;
  if (apiKey === null) {
    throw new SearchError(
      "EMBEDDING_KEY_MISSING",
      `${label} api key is required when ${label} is enabled`,
    );
  }

  return Object.freeze({
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    apiKey,
  });
}
