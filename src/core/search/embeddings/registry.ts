/**
 * Provider registry (Embedding Provider Suite).
 *
 * Named provider profiles persisted to
 * `Brain/search/embedding-providers.json`, added and removed at runtime
 * through the CLI so users register an OpenAI-compatible endpoint
 * without editing config. A registered name resolves to `openai-compat`
 * config at config-resolution time (see `expandRegisteredProvider`),
 * AFTER the built-ins, so a configured built-in key is never shadowed
 * and the resolved provider union stays closed.
 *
 * Only env-key NAMES are stored, never secret values - the file is safe
 * to sync. Loading is fail-soft: an absent or malformed registry yields
 * an empty list and never throws into the hot path.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SearchError } from "../types.ts";

/** A registered OpenAI-compatible provider profile. */
export interface ProviderProfile {
  readonly name: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /**
   * Environment variable NAME(s) the API key is read from (never the key).
   * A single string keeps the original single-key behaviour; an ordered
   * list is a probe list resolved first-present-wins, with the remaining
   * present keys kept as request-time failover candidates.
   */
  readonly envKey: string | ReadonlyArray<string>;
}

/** Normalise `envKey` (string | list) to an ordered list of env-var names. */
function envKeyList(envKey: ProviderProfile["envKey"]): string[] {
  const raw = typeof envKey === "string" ? [envKey] : [...envKey];
  return raw.map((k) => k.trim()).filter((k) => k !== "");
}

/** Built-in provider names a profile may not reuse. */
export const RESERVED_PROVIDER_NAMES: ReadonlyArray<string> = Object.freeze([
  "openai-compat",
  "disabled",
  "local",
]);

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function providerRegistryPath(vault: string): string {
  return join(vault, "Brain", "search", "embedding-providers.json");
}

function isEnvKey(value: unknown): value is string | ReadonlyArray<string> {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every((k) => typeof k === "string");
}

function isProfile(value: unknown): value is ProviderProfile {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    typeof v["baseUrl"] === "string" &&
    typeof v["defaultModel"] === "string" &&
    isEnvKey(v["envKey"])
  );
}

/** Load the registry, fail-soft: absent or malformed file -> empty list. */
export function loadProviderRegistry(vault: string): ProviderProfile[] {
  let text: string;
  try {
    text = readFileSync(providerRegistryPath(vault), "utf8");
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

function writeProviderRegistry(vault: string, registry: ReadonlyArray<ProviderProfile>): void {
  const path = providerRegistryPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  // Sort by name so the on-disk file is deterministic across edits.
  const sorted = [...registry].toSorted((a, b) => a.name.localeCompare(b.name));
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
}

function validateProfile(profile: ProviderProfile): void {
  const name = profile.name.trim();
  if (!NAME_RE.test(name)) {
    throw new SearchError(
      "INVALID_INPUT",
      `provider name must be a lowercase slug ([a-z0-9-], starting alphanumeric), got '${profile.name}'`,
    );
  }
  if (RESERVED_PROVIDER_NAMES.includes(name)) {
    throw new SearchError(
      "INVALID_INPUT",
      `provider name '${name}' is reserved for a built-in provider`,
    );
  }
  if (profile.baseUrl.trim() === "") {
    throw new SearchError("INVALID_INPUT", "provider base-url must not be empty");
  }
  if (profile.defaultModel.trim() === "") {
    throw new SearchError("INVALID_INPUT", "provider default-model must not be empty");
  }
  if (envKeyList(profile.envKey).length === 0) {
    throw new SearchError(
      "INVALID_INPUT",
      "provider env-key must not be empty (and a probe list must hold at least one non-empty name)",
    );
  }
}

/**
 * Add (or upsert by name) a provider profile and persist. Returns the
 * full registry after the change.
 */
export function addProviderProfile(vault: string, profile: ProviderProfile): ProviderProfile[] {
  validateProfile(profile);
  const keys = envKeyList(profile.envKey);
  const normalised: ProviderProfile = Object.freeze({
    name: profile.name.trim(),
    baseUrl: profile.baseUrl.trim(),
    defaultModel: profile.defaultModel.trim(),
    // Preserve the single-string shape for single-key profiles so existing
    // registry files stay byte-identical; store a list only when given one.
    envKey: typeof profile.envKey === "string" ? keys[0]! : Object.freeze(keys),
  });
  const without = loadProviderRegistry(vault).filter((p) => p.name !== normalised.name);
  const next = [...without, normalised];
  writeProviderRegistry(vault, next);
  return loadProviderRegistry(vault);
}

/** Remove a profile by name; reports whether one was present. */
export function removeProviderProfile(
  vault: string,
  name: string,
): { removed: boolean; registry: ProviderProfile[] } {
  const current = loadProviderRegistry(vault);
  const next = current.filter((p) => p.name !== name);
  const removed = next.length !== current.length;
  if (removed) writeProviderRegistry(vault, next);
  return { removed, registry: loadProviderRegistry(vault) };
}

export function getProviderProfile(vault: string, name: string): ProviderProfile | null {
  return loadProviderRegistry(vault).find((p) => p.name === name) ?? null;
}

/** Fields a registered name expands into at config-resolution time. */
export interface ExpandedProvider {
  readonly provider: "openai-compat";
  readonly baseUrl: string;
  readonly model: string;
  /** First present probe key (backward-compatible single value); null if none set. */
  readonly apiKey: string | null;
  /** All present probe keys in profile order; request-time failover candidates. */
  readonly apiKeys: ReadonlyArray<string>;
}

/**
 * Expand a registered provider name into `openai-compat` config, resolving
 * the API key(s) from the profile's `envKey` probe list (first-present
 * wins; the rest are kept as failover candidates). Returns null when the
 * name is not registered (the caller then falls back to built-in
 * resolution).
 */
export function expandRegisteredProvider(
  name: string,
  registry: ReadonlyArray<ProviderProfile>,
  env: Readonly<Record<string, string | undefined>>,
): ExpandedProvider | null {
  const profile = registry.find((p) => p.name === name);
  if (!profile) return null;
  const present = envKeyList(profile.envKey)
    .map((varName) => env[varName])
    .filter((v): v is string => v !== undefined && v !== "");
  return Object.freeze({
    provider: "openai-compat" as const,
    baseUrl: profile.baseUrl,
    model: profile.defaultModel,
    apiKey: present[0] ?? null,
    apiKeys: Object.freeze(present),
  });
}
