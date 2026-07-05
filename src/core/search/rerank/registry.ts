/**
 * Rerank-provider registry (retrieval-precision-quality-loop, card A /
 * t_110867f5).
 *
 * Named cross-encoder provider profiles persisted to
 * `Brain/search/rerank-providers.json`, added and removed at runtime
 * through the CLI so users register an OpenAI-compatible rerank endpoint
 * without editing config. A registered name resolves to `base_url +
 * model + env-key` at config-resolution time (see
 * {@link expandRegisteredRerankProvider}); an explicit `search_rerank_*`
 * config/env value always wins over the profile's field.
 *
 * Only env-key NAMES are stored, never secret values - the file is safe
 * to sync. Loading is fail-soft: an absent or malformed registry yields
 * an empty list and never throws into the hot path.
 *
 * Mirrors `embeddings/registry.ts` deliberately: the two registries are
 * the same shape so the CLI verbs, validation, and on-disk determinism
 * stay consistent between the embedding and rerank surfaces.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SearchError } from "../types.ts";

/** A registered OpenAI-compatible rerank provider profile. */
export interface RerankProviderProfile {
  readonly name: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** Environment variable NAME the API key is read from (never the key). */
  readonly envKey: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function rerankRegistryPath(vault: string): string {
  return join(vault, "Brain", "search", "rerank-providers.json");
}

function isProfile(value: unknown): value is RerankProviderProfile {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    typeof v["baseUrl"] === "string" &&
    typeof v["defaultModel"] === "string" &&
    typeof v["envKey"] === "string"
  );
}

/** Load the registry, fail-soft: absent or malformed file -> empty list. */
export function loadRerankRegistry(vault: string): RerankProviderProfile[] {
  let text: string;
  try {
    text = readFileSync(rerankRegistryPath(vault), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isProfile).map((p) => Object.freeze({ ...p }));
}

function writeRerankRegistry(vault: string, registry: ReadonlyArray<RerankProviderProfile>): void {
  const path = rerankRegistryPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  // Sort by name so the on-disk file is deterministic across edits.
  const sorted = [...registry].toSorted((a, b) => a.name.localeCompare(b.name));
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
}

function validateProfile(profile: RerankProviderProfile): void {
  const name = profile.name.trim();
  if (!NAME_RE.test(name)) {
    throw new SearchError(
      "INVALID_INPUT",
      `rerank provider name must be a lowercase slug ([a-z0-9-], starting alphanumeric), got '${profile.name}'`,
    );
  }
  if (profile.baseUrl.trim() === "") {
    throw new SearchError("INVALID_INPUT", "rerank provider base-url must not be empty");
  }
  if (profile.defaultModel.trim() === "") {
    throw new SearchError("INVALID_INPUT", "rerank provider default-model must not be empty");
  }
  if (profile.envKey.trim() === "") {
    throw new SearchError("INVALID_INPUT", "rerank provider env-key must not be empty");
  }
}

/**
 * Add (or upsert by name) a rerank provider profile and persist. Returns
 * the full registry after the change.
 */
export function addRerankProviderProfile(
  vault: string,
  profile: RerankProviderProfile,
): RerankProviderProfile[] {
  validateProfile(profile);
  const normalised: RerankProviderProfile = Object.freeze({
    name: profile.name.trim(),
    baseUrl: profile.baseUrl.trim(),
    defaultModel: profile.defaultModel.trim(),
    envKey: profile.envKey.trim(),
  });
  const without = loadRerankRegistry(vault).filter((p) => p.name !== normalised.name);
  const next = [...without, normalised];
  writeRerankRegistry(vault, next);
  return loadRerankRegistry(vault);
}

/** Remove a profile by name; reports whether one was present. */
export function removeRerankProviderProfile(
  vault: string,
  name: string,
): { removed: boolean; registry: RerankProviderProfile[] } {
  const current = loadRerankRegistry(vault);
  const next = current.filter((p) => p.name !== name);
  const removed = next.length !== current.length;
  if (removed) writeRerankRegistry(vault, next);
  return { removed, registry: loadRerankRegistry(vault) };
}

export function getRerankProviderProfile(
  vault: string,
  name: string,
): RerankProviderProfile | null {
  return loadRerankRegistry(vault).find((p) => p.name === name) ?? null;
}

/** Fields a registered name expands into at config-resolution time. */
export interface ExpandedRerankProvider {
  readonly baseUrl: string;
  readonly model: string;
  readonly envKey: string;
}

/**
 * Expand a registered rerank provider name into its endpoint fields.
 * Returns null when the name is not registered (the caller then relies on
 * the explicit `search_rerank_*` config keys alone).
 */
export function expandRegisteredRerankProvider(
  name: string,
  registry: ReadonlyArray<RerankProviderProfile>,
): ExpandedRerankProvider | null {
  const profile = registry.find((p) => p.name === name);
  if (!profile) return null;
  return Object.freeze({
    baseUrl: profile.baseUrl,
    model: profile.defaultModel,
    envKey: profile.envKey,
  });
}
