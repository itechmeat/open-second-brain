import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { SearchError } from "../../../src/core/search/types.ts";

let tmp: string;
let configPath: string;
let origEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "OPEN_SECOND_BRAIN_SEARCH_DB",
  "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC",
  "OPEN_SECOND_BRAIN_SEARCH_CHUNK_SIZE",
  "OPEN_SECOND_BRAIN_SEARCH_CHUNK_OVERLAP",
  "OPEN_SECOND_BRAIN_SEARCH_KW_WEIGHT",
  "OPEN_SECOND_BRAIN_SEARCH_SEM_WEIGHT",
  "OPEN_SECOND_BRAIN_SEARCH_IGNORE",
  "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
  "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL",
  "OPEN_SECOND_BRAIN_EMBEDDING_MODEL",
  "OPEN_SECOND_BRAIN_EMBEDDING_KEY",
  "OPEN_SECOND_BRAIN_EMBEDDING_DIM",
  "OPEN_SECOND_BRAIN_EMBEDDING_TIMEOUT",
  "OPEN_SECOND_BRAIN_EMBEDDING_CONCURRENCY",
  "OPEN_SECOND_BRAIN_EMBEDDING_BATCH",
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-cfg-"));
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

test("defaults are returned when config and env are empty", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.vault).toBe(tmp);
  expect(cfg.dbPath).toBe(join(tmp, ".open-second-brain", "brain.sqlite"));
  expect(cfg.chunkSize).toBe(800);
  expect(cfg.chunkOverlap).toBe(100);
  expect(cfg.keywordWeight).toBe(0.6);
  expect(cfg.semanticWeight).toBe(0.4);
  expect(cfg.semantic.enabled).toBe(false);
  expect(cfg.semantic.provider).toBe("openai-compat");
  expect(cfg.semantic.apiKey).toBeNull();
  expect(cfg.ignorePaths).toContain(".git");
  expect(cfg.ignorePaths).toContain(".open-second-brain");
});

test("env overrides config which overrides defaults", () => {
  writeFileSync(
    configPath,
    [
      `vault: "${tmp}"`,
      `search_chunk_size: "500"`,
      `search_semantic_enabled: "true"`,
      `embedding_base_url: "https://config.example/v1"`,
      `embedding_model: "config-model"`,
      `embedding_api_key: "cfg-key"`,
    ].join("\n") + "\n",
  );
  process.env["OPEN_SECOND_BRAIN_EMBEDDING_MODEL"] = "env-model";
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.chunkSize).toBe(500);
  expect(cfg.semantic.enabled).toBe(true);
  expect(cfg.semantic.baseUrl).toBe("https://config.example/v1");
  expect(cfg.semantic.model).toBe("env-model");
  expect(cfg.semantic.apiKey).toBe("cfg-key");
});

test("overrides win over both env and config", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_chunk_size: "500"\n`);
  process.env["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC"] = "false";
  const cfg = resolveSearchConfig({
    vault: tmp,
    configPath,
    overrides: { keywordWeight: 0.9, semanticWeight: 0.1 },
  });
  expect(cfg.keywordWeight).toBe(0.9);
  expect(cfg.semanticWeight).toBe(0.1);
});

test("invalid numeric value throws INVALID_INPUT", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_chunk_size: "not-a-number"\n`);
  let err: SearchError | null = null;
  try {
    resolveSearchConfig({ vault: tmp, configPath });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err).not.toBeNull();
  expect(err?.code).toBe("INVALID_INPUT");
  expect(err?.message).toContain("search_chunk_size");
});

test("weights summing above 1 is rejected", () => {
  writeFileSync(
    configPath,
    `vault: "${tmp}"\nsearch_keyword_weight: "0.7"\nsearch_semantic_weight: "0.5"\n`,
  );
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(/sum.*1/);
});

test("non-positive integer knobs are rejected before provider construction", () => {
  for (const key of [
    "search_chunk_size",
    "embedding_dimension",
    "embedding_timeout_ms",
    "embedding_concurrency",
    "embedding_batch_size",
  ]) {
    writeFileSync(configPath, `vault: "${tmp}"\n${key}: "0"\n`);
    expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(key);
  }
});

test("chunk overlap must be non-negative and smaller than chunk size", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_chunk_overlap: "-1"\n`);
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(/search_chunk_overlap/);

  writeFileSync(
    configPath,
    `vault: "${tmp}"\nsearch_chunk_size: "100"\nsearch_chunk_overlap: "100"\n`,
  );
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(/smaller than/);
});

test("overrides are validated after merging", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  expect(() =>
    resolveSearchConfig({
      vault: tmp,
      configPath,
      overrides: { keywordWeight: Number.NaN },
    }),
  ).toThrow(/search_keyword_weight/);
  expect(() =>
    resolveSearchConfig({
      vault: tmp,
      configPath,
      overrides: { semantic: { batchSize: 0 } },
    }),
  ).toThrow(/embedding_batch_size/);
});
