import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadProviderRegistry,
  addProviderProfile,
  removeProviderProfile,
  getProviderProfile,
  expandRegisteredProvider,
  providerRegistryPath,
  RESERVED_PROVIDER_NAMES,
} from "../../../src/core/search/embeddings/registry.ts";
import { SearchError } from "../../../src/core/search/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-registry-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const nim = {
  name: "nvidia-nim",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  defaultModel: "nvidia/nv-embed-v1",
  envKey: "NIM_API_KEY",
};

test("empty vault has an empty registry", () => {
  expect(loadProviderRegistry(vault)).toEqual([]);
});

test("add -> list -> get -> remove round-trips a profile", () => {
  const after = addProviderProfile(vault, nim);
  expect(after).toHaveLength(1);
  expect(loadProviderRegistry(vault)).toHaveLength(1);
  expect(getProviderProfile(vault, "nvidia-nim")).toMatchObject(nim);

  const { removed, registry } = removeProviderProfile(vault, "nvidia-nim");
  expect(removed).toBe(true);
  expect(registry).toEqual([]);
  expect(getProviderProfile(vault, "nvidia-nim")).toBeNull();
});

test("registry persists to Brain/search/embedding-providers.json", () => {
  addProviderProfile(vault, nim);
  expect(providerRegistryPath(vault)).toBe(
    join(vault, "Brain", "search", "embedding-providers.json"),
  );
});

test("add upserts an existing name rather than duplicating", () => {
  addProviderProfile(vault, nim);
  const after = addProviderProfile(vault, { ...nim, defaultModel: "nvidia/nv-embed-v2" });
  expect(after).toHaveLength(1);
  expect(getProviderProfile(vault, "nvidia-nim")?.defaultModel).toBe("nvidia/nv-embed-v2");
});

test("reserved built-in names cannot be registered", () => {
  for (const reserved of RESERVED_PROVIDER_NAMES) {
    expect(() => addProviderProfile(vault, { ...nim, name: reserved })).toThrow(SearchError);
  }
});

test("invalid profile fields are rejected", () => {
  expect(() => addProviderProfile(vault, { ...nim, name: "Bad Name" })).toThrow(/name/i);
  expect(() => addProviderProfile(vault, { ...nim, baseUrl: "" })).toThrow(/base/i);
  expect(() => addProviderProfile(vault, { ...nim, defaultModel: "" })).toThrow(/model/i);
  expect(() => addProviderProfile(vault, { ...nim, envKey: "" })).toThrow(/env/i);
});

test("removing an absent profile reports removed:false", () => {
  const { removed } = removeProviderProfile(vault, "ghost");
  expect(removed).toBe(false);
});

test("expandRegisteredProvider resolves to openai-compat with the env key", () => {
  const registry = addProviderProfile(vault, nim);
  const expanded = expandRegisteredProvider("nvidia-nim", registry, { NIM_API_KEY: "secret-123" });
  expect(expanded).toEqual({
    provider: "openai-compat",
    baseUrl: nim.baseUrl,
    model: nim.defaultModel,
    apiKey: "secret-123",
  });
});

test("expandRegisteredProvider yields a null apiKey when the env var is unset", () => {
  const registry = addProviderProfile(vault, nim);
  const expanded = expandRegisteredProvider("nvidia-nim", registry, {});
  expect(expanded?.apiKey).toBeNull();
});

test("expandRegisteredProvider returns null for an unknown name", () => {
  expect(expandRegisteredProvider("missing", [], {})).toBeNull();
});

test("a malformed registry file degrades to empty, never throws", () => {
  mkdirSync(join(vault, "Brain", "search"), { recursive: true });
  writeFileSync(providerRegistryPath(vault), "{ not json");
  expect(loadProviderRegistry(vault)).toEqual([]);
});
