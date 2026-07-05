/**
 * Rerank-provider registry (retrieval-precision-quality-loop, card A /
 * t_110867f5). Mirrors the embedding registry: env-key NAMES only,
 * fail-soft load, deterministic on-disk order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
