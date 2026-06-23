import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  "OPEN_SECOND_BRAIN_SEARCH_CHUNK_MIN_SIZE",
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
  "OPEN_SECOND_BRAIN_SEARCH_RECENCY_SHAPE",
  "OPEN_SECOND_BRAIN_SEARCH_RECENCY_SCALE",
  "OPEN_SECOND_BRAIN_SEARCH_RECENCY_AMPLITUDE",
  "OPEN_SECOND_BRAIN_SEARCH_INTENT_ENABLED",
  "OPEN_SECOND_BRAIN_SEARCH_SYNONYM_ENABLED",
  "OPEN_SECOND_BRAIN_SEARCH_SYNONYM_MAX_TERMS",
  "OPEN_SECOND_BRAIN_SEARCH_CACHE_ENABLED",
  "OPEN_SECOND_BRAIN_SEARCH_CACHE_TTL",
  "OPEN_SECOND_BRAIN_SEARCH_SHUTDOWN_GRACE",
  "OPEN_SECOND_BRAIN_SEARCH_RESUME_REINDEX",
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
  expect(cfg.chunkMinSize).toBe(100);
  expect(cfg.keywordWeight).toBe(0.6);
  expect(cfg.semanticWeight).toBe(0.4);
  expect(cfg.semantic.enabled).toBe(false);
  expect(cfg.semantic.provider).toBe("openai-compat");
  expect(cfg.semantic.apiKey).toBeNull();
  const ignoreRaws = cfg.ignoreRules.map((r) => r.raw);
  expect(ignoreRaws).toContain(".git");
  expect(ignoreRaws).toContain(".open-second-brain");
  // v0.10.9: the default set folds in `.obsidian` (whole dir) and
  // `Brain/.snapshots`. These come from the shared `vault-scope`
  // defaults, not the legacy `search_ignore_paths` plumbing.
  expect(ignoreRaws).toContain(".obsidian");
  expect(ignoreRaws).toContain("Brain/.snapshots");
});

test("recall recency defaults to the Weibull curve params", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.recall.recencyShape).toBe(0.8);
  expect(cfg.recall.recencyScale).toBe(30);
  expect(cfg.recall.recencyAmplitude).toBe(0.05);
});

test("recency curve params are overridable via env and config", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_recency_scale: "45"\n`);
  process.env["OPEN_SECOND_BRAIN_SEARCH_RECENCY_SHAPE"] = "1.2";
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.recall.recencyShape).toBe(1.2);
  expect(cfg.recall.recencyScale).toBe(45);
});

test("query-intent classification defaults on and is toggleable", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  expect(resolveSearchConfig({ vault: tmp, configPath }).recall.intentEnabled).toBe(true);
  process.env["OPEN_SECOND_BRAIN_SEARCH_INTENT_ENABLED"] = "false";
  expect(resolveSearchConfig({ vault: tmp, configPath }).recall.intentEnabled).toBe(false);
});

test("synonym expansion defaults off and is toggleable with a term cap", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  const def = resolveSearchConfig({ vault: tmp, configPath }).recall;
  expect(def.synonymEnabled).toBe(false);
  expect(def.synonymMaxTerms).toBe(3);
  process.env["OPEN_SECOND_BRAIN_SEARCH_SYNONYM_ENABLED"] = "true";
  process.env["OPEN_SECOND_BRAIN_SEARCH_SYNONYM_MAX_TERMS"] = "5";
  const on = resolveSearchConfig({ vault: tmp, configPath }).recall;
  expect(on.synonymEnabled).toBe(true);
  expect(on.synonymMaxTerms).toBe(5);
});

test("query cache defaults off with a 300s TTL and is toggleable", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  const def = resolveSearchConfig({ vault: tmp, configPath }).recall;
  expect(def.cacheEnabled).toBe(false);
  expect(def.cacheTtlSeconds).toBe(300);
  process.env["OPEN_SECOND_BRAIN_SEARCH_CACHE_ENABLED"] = "true";
  process.env["OPEN_SECOND_BRAIN_SEARCH_CACHE_TTL"] = "60";
  const on = resolveSearchConfig({ vault: tmp, configPath }).recall;
  expect(on.cacheEnabled).toBe(true);
  expect(on.cacheTtlSeconds).toBe(60);
});

test("non-positive recency scale is rejected", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_recency_scale: "0"\n`);
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(/search_recency_scale/);
});

test("recency amplitude outside [0,1] is rejected", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_recency_amplitude: "2"\n`);
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(/search_recency_amplitude/);
});

test("OPEN_SECOND_BRAIN_SEARCH_IGNORE has no effect (removed in v0.10.9)", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  process.env["OPEN_SECOND_BRAIN_SEARCH_IGNORE"] = "from-env-1,from-env-2";
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  const raws = cfg.ignoreRules.map((r) => r.raw);
  expect(raws).not.toContain("from-env-1");
  expect(raws).not.toContain("from-env-2");
});

test("search_ignore_paths in config.yaml has no effect (removed in v0.10.9)", () => {
  writeFileSync(
    configPath,
    `vault: "${tmp}"\nsearch_ignore_paths: "from-config-1,from-config-2"\n`,
  );
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  const raws = cfg.ignoreRules.map((r) => r.raw);
  expect(raws).not.toContain("from-config-1");
  expect(raws).not.toContain("from-config-2");
});

test("vault.ignore_paths in Brain/_brain.yaml is the source of truth", () => {
  mkdirSync(join(tmp, "Brain"), { recursive: true });
  writeFileSync(
    join(tmp, "Brain", "_brain.yaml"),
    `schema_version: 1
vault:
  ignore_paths:
    - my-cache
    - Drafts
`,
  );
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.ignoreRules.map((r) => r.raw)).toEqual(["my-cache", "Drafts"]);
  // The path-style entry survives classification.
  const draftsRule = cfg.ignoreRules.find((r) => r.raw === "Drafts");
  expect(draftsRule?.kind).toBe("name");
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

test("overrides can repair invalid configured weight sums", () => {
  writeFileSync(
    configPath,
    `vault: "${tmp}"\nsearch_keyword_weight: "0.7"\nsearch_semantic_weight: "0.5"\n`,
  );
  const cfg = resolveSearchConfig({
    vault: tmp,
    configPath,
    overrides: { keywordWeight: 0.5, semanticWeight: 0.5 },
  });
  expect(cfg.keywordWeight).toBe(0.5);
  expect(cfg.semanticWeight).toBe(0.5);
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

test("chunk minimum size resolves from config and env overrides config", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_chunk_min_size: "50"\n`);
  expect(resolveSearchConfig({ vault: tmp, configPath }).chunkMinSize).toBe(50);

  process.env["OPEN_SECOND_BRAIN_SEARCH_CHUNK_MIN_SIZE"] = "75";
  expect(resolveSearchConfig({ vault: tmp, configPath }).chunkMinSize).toBe(75);
});

test("chunk minimum size must be a positive integer not exceeding chunk size", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_chunk_min_size: "0"\n`);
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(/search_chunk_min_size/);

  writeFileSync(
    configPath,
    `vault: "${tmp}"\nsearch_chunk_size: "300"\nsearch_chunk_min_size: "400"\n`,
  );
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(/exceed/);
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

// ── Indexer Durability suite: shutdown grace + resume flag ──────────────────

test("durability keys default to a 5s grace and no resume", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.shutdownGraceMs).toBe(5_000);
  expect(cfg.resumeReindex).toBe(false);
});

test("config keys override the durability defaults", () => {
  writeFileSync(
    configPath,
    `vault: "${tmp}"\nsearch_shutdown_grace_seconds: 12\nsearch_resume_reindex: true\n`,
  );
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.shutdownGraceMs).toBe(12_000);
  expect(cfg.resumeReindex).toBe(true);
});

test("env mirrors override the durability config", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_shutdown_grace_seconds: 12\n`);
  process.env["OPEN_SECOND_BRAIN_SEARCH_SHUTDOWN_GRACE"] = "3";
  process.env["OPEN_SECOND_BRAIN_SEARCH_RESUME_REINDEX"] = "true";
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.shutdownGraceMs).toBe(3_000);
  expect(cfg.resumeReindex).toBe(true);
});

test("an invalid grace is rejected loudly (no silent fallback)", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_shutdown_grace_seconds: soon\n`);
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(
    /search_shutdown_grace_seconds/,
  );
});

test("grace of 0 disables the await window", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_shutdown_grace_seconds: 0\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.shutdownGraceMs).toBe(0);
});
