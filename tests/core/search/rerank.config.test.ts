/**
 * Cross-encoder rerank config resolution (retrieval-precision-quality-loop,
 * card A / t_110867f5). The `search_rerank_*` keys resolve through
 * `resolveSearchConfig` (config file + env parity), a registered provider
 * name supplies endpoint defaults, and explicit keys win.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { addRerankProviderProfile } from "../../../src/core/search/rerank/registry.ts";
import { SearchError } from "../../../src/core/search/types.ts";

let tmp: string;
let configPath: string;

const ENV_KEYS = [
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_ENABLED",
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_PROVIDER",
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_BASE_URL",
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_MODEL",
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_ENV_KEY",
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_TOP_K",
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_MIN_SCORE",
  "MY_RERANK_KEY",
];
let origEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-rerank-cfg-"));
  configPath = join(tmp, "config.yaml");
  origEnv = {};
  for (const k of ENV_KEYS) {
    origEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("default: rerank disabled, byte-identical zero-cost stage", () => {
  writeFileSync(configPath, "vault: " + tmp + "\n");
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.rerank.enabled).toBe(false);
  expect(cfg.rerank.baseUrl).toBeNull();
  expect(cfg.rerank.topK).toBe(20);
  expect(cfg.rerank.minScore).toBe(0);
});

test("explicit config keys resolve, with the api key read from env-key", () => {
  process.env["MY_RERANK_KEY"] = "sk-rerank";
  writeFileSync(
    configPath,
    [
      "vault: " + tmp,
      "search_rerank_enabled: true",
      "search_rerank_base_url: https://api.example.com/v1/",
      "search_rerank_model: rerank-1",
      "search_rerank_env_key: MY_RERANK_KEY",
      "search_rerank_top_k: 8",
      "search_rerank_min_score: 0.25",
    ].join("\n") + "\n",
  );
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.rerank).toEqual({
    enabled: true,
    baseUrl: "https://api.example.com/v1/",
    model: "rerank-1",
    envKey: "MY_RERANK_KEY",
    apiKey: "sk-rerank",
    topK: 8,
    minScore: 0.25,
  });
});

test("a registered provider name supplies endpoint defaults", () => {
  addRerankProviderProfile(tmp, {
    name: "jina",
    baseUrl: "https://api.jina.ai/v1",
    defaultModel: "jina-reranker-v2",
    envKey: "MY_RERANK_KEY",
  });
  process.env["MY_RERANK_KEY"] = "jina-secret";
  writeFileSync(
    configPath,
    ["vault: " + tmp, "search_rerank_enabled: true", "search_rerank_provider: jina"].join("\n") +
      "\n",
  );
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.rerank.baseUrl).toBe("https://api.jina.ai/v1");
  expect(cfg.rerank.model).toBe("jina-reranker-v2");
  expect(cfg.rerank.envKey).toBe("MY_RERANK_KEY");
  expect(cfg.rerank.apiKey).toBe("jina-secret");
});

test("explicit keys win over a registered provider profile", () => {
  addRerankProviderProfile(tmp, {
    name: "jina",
    baseUrl: "https://api.jina.ai/v1",
    defaultModel: "jina-reranker-v2",
    envKey: "MY_RERANK_KEY",
  });
  writeFileSync(
    configPath,
    [
      "vault: " + tmp,
      "search_rerank_enabled: true",
      "search_rerank_provider: jina",
      "search_rerank_model: override-model",
    ].join("\n") + "\n",
  );
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.rerank.model).toBe("override-model");
  expect(cfg.rerank.baseUrl).toBe("https://api.jina.ai/v1"); // still from profile
});

test("env var overrides the config file", () => {
  writeFileSync(configPath, ["vault: " + tmp, "search_rerank_top_k: 5"].join("\n") + "\n");
  process.env["OPEN_SECOND_BRAIN_SEARCH_RERANK_TOP_K"] = "12";
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.rerank.topK).toBe(12);
});

test("a non-integer top_k fails closed", () => {
  writeFileSync(configPath, ["vault: " + tmp, "search_rerank_top_k: notanumber"].join("\n") + "\n");
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(SearchError);
});

test("overrides.rerank accepts a partial config and merges it over the base", () => {
  // Resolves the base with rerank enabled so every field is populated, then
  // overrides only topK. The merged config keeps base.baseUrl/model but takes
  // the partial topK. This also guards the type: a partial rerank override
  // (e.g. { topK: 5 }) must type-check like the semantic override does.
  process.env["MY_RERANK_KEY"] = "sk-rerank";
  writeFileSync(
    configPath,
    [
      "vault: " + tmp,
      "search_rerank_enabled: true",
      "search_rerank_base_url: https://api.example.com/v1/",
      "search_rerank_model: rerank-1",
      "search_rerank_env_key: MY_RERANK_KEY",
      "search_rerank_top_k: 20",
      "search_rerank_min_score: 0",
    ].join("\n") + "\n",
  );
  const cfg = resolveSearchConfig({ vault: tmp, configPath, overrides: { rerank: { topK: 5 } } });
  expect(cfg.rerank.topK).toBe(5);
  expect(cfg.rerank.baseUrl).toBe("https://api.example.com/v1/");
  expect(cfg.rerank.model).toBe("rerank-1");
});
