/**
 * Rerank-provider registry (retrieval-precision-quality-loop, card A /
 * t_110867f5). Mirrors the embedding registry: env-key NAMES only,
 * fail-soft load, deterministic on-disk order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  addRerankProviderProfile,
  expandRegisteredRerankProvider,
  getRerankProviderProfile,
  loadRerankRegistry,
  removeRerankProviderProfile,
  rerankRegistryPath,
} from "../../../src/core/search/rerank/registry.ts";
import { SearchError } from "../../../src/core/search/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "rerank-registry-"));
  // A legacy vault: its registry lives in the vault. A vault with no
  // `Brain/` is store-only and keeps it in device-local state.
  mkdirSync(join(vault, "Brain"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("rerank registry", () => {
  test("absent registry loads fail-soft to an empty list", () => {
    expect(loadRerankRegistry(vault)).toEqual([]);
  });

  test("add persists a profile and round-trips through load", () => {
    addRerankProviderProfile(vault, {
      name: "jina",
      baseUrl: "https://api.jina.ai/v1",
      defaultModel: "jina-reranker-v2",
      envKey: "JINA_API_KEY",
    });
    const loaded = loadRerankRegistry(vault);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual({
      name: "jina",
      baseUrl: "https://api.jina.ai/v1",
      defaultModel: "jina-reranker-v2",
      envKey: "JINA_API_KEY",
    });
  });

  test("stored file contains the env-key NAME, never a secret value", () => {
    addRerankProviderProfile(vault, {
      name: "cohere",
      baseUrl: "https://api.cohere.ai/v1",
      defaultModel: "rerank-english-v3.0",
      envKey: "COHERE_API_KEY",
    });
    const raw = readFileSync(rerankRegistryPath(vault), "utf8");
    expect(raw).toContain("COHERE_API_KEY");
    expect(raw).not.toContain("secret");
  });

  test("add upserts by name and keeps the file name-sorted", () => {
    addRerankProviderProfile(vault, {
      name: "zeta",
      baseUrl: "https://z/v1",
      defaultModel: "m",
      envKey: "Z_KEY",
    });
    addRerankProviderProfile(vault, {
      name: "alpha",
      baseUrl: "https://a/v1",
      defaultModel: "m",
      envKey: "A_KEY",
    });
    addRerankProviderProfile(vault, {
      name: "alpha",
      baseUrl: "https://a2/v1",
      defaultModel: "m2",
      envKey: "A_KEY2",
    });
    const loaded = loadRerankRegistry(vault);
    expect(loaded.map((p) => p.name)).toEqual(["alpha", "zeta"]);
    expect(loaded.find((p) => p.name === "alpha")?.baseUrl).toBe("https://a2/v1");
  });

  test("remove reports presence and deletes the profile", () => {
    addRerankProviderProfile(vault, {
      name: "jina",
      baseUrl: "https://api.jina.ai/v1",
      defaultModel: "jina-reranker-v2",
      envKey: "JINA_API_KEY",
    });
    expect(removeRerankProviderProfile(vault, "nope").removed).toBe(false);
    expect(removeRerankProviderProfile(vault, "jina").removed).toBe(true);
    expect(getRerankProviderProfile(vault, "jina")).toBeNull();
  });

  test("invalid name is rejected with a typed error", () => {
    expect(() =>
      addRerankProviderProfile(vault, {
        name: "Bad Name",
        baseUrl: "https://x/v1",
        defaultModel: "m",
        envKey: "K",
      }),
    ).toThrow(SearchError);
  });

  test("a malformed registry file loads fail-soft to empty", () => {
    mkdirSync(join(vault, "Brain", "search"), { recursive: true });
    writeFileSync(rerankRegistryPath(vault), "{ not json");
    expect(loadRerankRegistry(vault)).toEqual([]);
  });

  test("expandRegisteredRerankProvider resolves endpoint fields by name", () => {
    const registry = [
      {
        name: "jina",
        baseUrl: "https://api.jina.ai/v1",
        defaultModel: "jina-reranker-v2",
        envKey: "JINA_API_KEY",
      },
    ];
    expect(expandRegisteredRerankProvider("jina", registry)).toEqual({
      baseUrl: "https://api.jina.ai/v1",
      model: "jina-reranker-v2",
      envKey: "JINA_API_KEY",
    });
    expect(expandRegisteredRerankProvider("missing", registry)).toBeNull();
  });
});

describe("rerank registry without the legacy tree", () => {
  // Each test gets its own device-local state base, so the registry a test
  // writes there (and the folders the relocation creates) never meets
  // another test's, and teardown removes all of it.
  const STATE_VARS = ["XDG_STATE_HOME", "LOCALAPPDATA"] as const;
  let stateBase: string;
  let savedState: Array<string | undefined>;
  beforeEach(() => {
    stateBase = mkdtempSync(join(tmpdir(), "o2b-rerank-state-"));
    savedState = STATE_VARS.map((name) => process.env[name]);
    for (const name of STATE_VARS) process.env[name] = stateBase;
  });
  afterEach(() => {
    STATE_VARS.forEach((name, i) => {
      const saved = savedState[i];
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    });
    rmSync(stateBase, { recursive: true, force: true });
  });

  test("a store-only vault keeps the registry device-local and writes nothing under it", () => {
    const bare = mkdtempSync(join(tmpdir(), "o2b-rerank-bare-"));
    try {
      addRerankProviderProfile(bare, {
        name: "jina",
        baseUrl: "https://api.jina.ai/v1",
        defaultModel: "jina-reranker-v2",
        envKey: "JINA_API_KEY",
      });
      expect(loadRerankRegistry(bare).map((p) => p.name)).toEqual(["jina"]);
      expect(rerankRegistryPath(bare).startsWith(bare)).toBe(false);
      expect(rerankRegistryPath(bare).startsWith(stateBase)).toBe(true);
      expect(readdirSync(bare)).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("with no vault the registry path is device-local and reads empty", () => {
    expect(isAbsolute(rerankRegistryPath(null))).toBe(true);
    expect(rerankRegistryPath(null).startsWith(stateBase)).toBe(true);
    expect(loadRerankRegistry(null)).toEqual([]);
  });
});
