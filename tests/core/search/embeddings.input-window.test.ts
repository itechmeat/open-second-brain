/**
 * The effective input window (honest-query-embed-and-safe-upgrades, task 1).
 *
 * One resolver answers "how many tokens does the configured model accept":
 * the operator's `embedding_input_window_tokens` when set, otherwise the
 * window the curated preset table declares, otherwise unknown (null). The
 * query fit and the oversize-chunk census both read it, so an operator who
 * declares the window of an uncurated model gets both from one key.
 *
 * Also pinned here: the query prefix the configured BACKEND sends, which
 * is not the prefix the configuration asks for. Only `openai-compat`
 * implements the instruction-prefix contract.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  declaredInputWindowTokens,
  effectiveInputWindowTokens,
  INPUT_WINDOW_TOKENS_KEY,
  queryPrefixSentByProvider,
  RECOMMENDED_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/presets.ts";
import { charLengthOverTokenBudget } from "../../../src/core/search/embeddings/signature.ts";
import type {
  EmbeddingProviderName,
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

const ENV_KEY = "OPEN_SECOND_BRAIN_EMBEDDING_INPUT_WINDOW_TOKENS";

/** A model string deliberately outside the curated table. */
const UNCURATED_MODEL = "acme/custom-embed-9000";

/** The curated window of the shipped recommended default. */
const RECOMMENDED_WINDOW = declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)!;

let vault: string;
let dbPath: string;
let configPath: string;
let cleanup: () => void;
let savedEnv: string | undefined;

beforeEach(() => {
  const v = createTempVault("input-window");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  configPath = join(vault, "_brain.yaml");
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  cleanup();
});

function writeConfig(extra = ""): void {
  writeFileSync(configPath, `vault: "${vault}"\n${extra}`);
}

function semantic(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl: "https://embeddings.invalid/v1",
    model: UNCURATED_MODEL,
    apiKey: FAKE_PROVIDER_KEY,
    dimension: 384,
    timeoutMs: 5_000,
    concurrency: 1,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 3,
    ...overrides,
  });
}

function indexCfg(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedSearchConfig {
  return Object.freeze(
    makeConfig({
      vault,
      dbPath,
      semantic: {
        enabled: true,
        provider: "openai-compat",
        // Never reached: the census is a read over already-indexed rows.
        baseUrl: "https://embeddings.invalid/v1",
        model: UNCURATED_MODEL,
        apiKey: FAKE_PROVIDER_KEY,
        dimension: 384,
        ...overrides,
      },
    }),
  );
}

// ── config resolution ────────────────────────────────────────────────────────

test("an absent key leaves the field absent", () => {
  writeConfig();
  const resolved = resolveSearchConfig({ vault, configPath }).semantic;
  expect("inputWindowTokens" in resolved).toBe(false);
  expect(JSON.stringify(resolved)).not.toContain("inputWindowTokens");
});

test("the key resolves from config, and the env variable beats config", () => {
  writeConfig(`${INPUT_WINDOW_TOKENS_KEY}: "300"\n`);
  expect(resolveSearchConfig({ vault, configPath }).semantic.inputWindowTokens).toBe(300);
  process.env[ENV_KEY] = "700";
  expect(resolveSearchConfig({ vault, configPath }).semantic.inputWindowTokens).toBe(700);
});

test("zero, a fraction and a blank value are refused from the string, naming the key", () => {
  for (const raw of ["0", "2.5", "", "   "]) {
    writeConfig(`${INPUT_WINDOW_TOKENS_KEY}: "${raw}"\n`);
    let caught: unknown = null;
    try {
      resolveSearchConfig({ vault, configPath });
    } catch (e) {
      caught = e;
    }
    expect(`${raw}: ${(caught as { code?: string } | null)?.code}`).toBe(`${raw}: INVALID_INPUT`);
    expect((caught as Error).message).toContain(INPUT_WINDOW_TOKENS_KEY);
  }
});

test("a blank env value is refused, naming the key", () => {
  writeConfig();
  process.env[ENV_KEY] = "";
  expect(() => resolveSearchConfig({ vault, configPath })).toThrow(INPUT_WINDOW_TOKENS_KEY);
});

test("zero, a fraction and a non-number are refused from an override, naming the key", () => {
  writeConfig();
  for (const bad of [0, -1, 2.5, Number.NaN]) {
    let caught: unknown = null;
    try {
      resolveSearchConfig({
        vault,
        configPath,
        overrides: { semantic: { inputWindowTokens: bad } },
      });
    } catch (e) {
      caught = e;
    }
    expect(`${bad}: ${(caught as { code?: string } | null)?.code}`).toBe(`${bad}: INVALID_INPUT`);
    expect((caught as Error).message).toContain(INPUT_WINDOW_TOKENS_KEY);
  }
});

test("the key is refused for the offline local embedder, naming the provider", () => {
  writeConfig(`embedding_provider: local\n${INPUT_WINDOW_TOKENS_KEY}: "512"\n`);
  let caught: unknown = null;
  try {
    resolveSearchConfig({ vault, configPath });
  } catch (e) {
    caught = e;
  }
  expect((caught as { code?: string } | null)?.code).toBe("INVALID_INPUT");
  expect((caught as Error).message).toContain(INPUT_WINDOW_TOKENS_KEY);
  expect((caught as Error).message).toContain("'local'");
});

test("an override cannot pair the local embedder with a window", () => {
  writeConfig();
  expect(() =>
    resolveSearchConfig({
      vault,
      configPath,
      overrides: { semantic: { provider: "local", inputWindowTokens: 64 } },
    }),
  ).toThrow(INPUT_WINDOW_TOKENS_KEY);
});

test("the key resolves for every provider that reads it", () => {
  for (const provider of ["openai-compat", "zeroentropy"]) {
    writeConfig(`embedding_provider: ${provider}\n${INPUT_WINDOW_TOKENS_KEY}: "512"\n`);
    expect(resolveSearchConfig({ vault, configPath }).semantic.inputWindowTokens).toBe(512);
  }
});

// ── the resolver ─────────────────────────────────────────────────────────────

test("the operator key beats the preset window", () => {
  expect(
    effectiveInputWindowTokens(
      semantic({ model: RECOMMENDED_EMBEDDING_MODEL, inputWindowTokens: 64 }),
    ),
  ).toBe(64);
});

test("the preset window applies when the key is absent", () => {
  expect(effectiveInputWindowTokens(semantic({ model: RECOMMENDED_EMBEDDING_MODEL }))).toBe(
    RECOMMENDED_WINDOW,
  );
});

test("an uncurated model with no key resolves to unknown, and unknown is not zero", () => {
  expect(effectiveInputWindowTokens(semantic())).toBeNull();
  expect(effectiveInputWindowTokens(semantic({ model: null }))).toBeNull();
  expect(effectiveInputWindowTokens(semantic({ inputWindowTokens: 300 }))).toBe(300);
});

test("a model passed explicitly stands in for an unset configured model", () => {
  expect(effectiveInputWindowTokens(semantic({ model: null }), RECOMMENDED_EMBEDDING_MODEL)).toBe(
    RECOMMENDED_WINDOW,
  );
});

test("the offline local embedder has no window, whatever the key says", () => {
  expect(
    effectiveInputWindowTokens(semantic({ provider: "local", inputWindowTokens: 64 })),
  ).toBeNull();
});

// ── the prefix the backend sends ─────────────────────────────────────────────

test("only openai-compat sends the configured query prefix", () => {
  const cases: ReadonlyArray<readonly [EmbeddingProviderName, string]> = [
    ["openai-compat", "query: "],
    ["zeroentropy", ""],
    ["local", ""],
    ["disabled", ""],
  ];
  for (const [provider, expected] of cases) {
    expect(`${provider}: ${JSON.stringify(queryPrefixSentByProvider(provider, "query: "))}`).toBe(
      `${provider}: ${JSON.stringify(expected)}`,
    );
  }
  expect(queryPrefixSentByProvider("openai-compat", undefined)).toBe("");
  expect(queryPrefixSentByProvider("openai-compat", "")).toBe("");
});

// ── the census reads the same resolver ───────────────────────────────────────

test("the census reports an over-window chunk for an uncurated model once the key is set", async () => {
  const window = 64;
  writeMd(vault, "big.md", `# Big\n\n${"overflow ".repeat(charLengthOverTokenBudget(window))}\n`);
  const undeclared = await indexVault(indexCfg());
  expect(undeclared.chunkWindow?.verdict).toBe("window-undeclared");

  const declared = await indexVault(indexCfg({ inputWindowTokens: window }), { force: true });
  const census = declared.chunkWindow;
  expect(census?.verdict).toBe("over-window");
  if (census?.verdict !== "over-window") throw new Error("verdict narrowed wrong");
  expect(census.model).toBe(UNCURATED_MODEL);
  expect(census.windowTokens).toBe(window);
  expect(census.chunksOverWindow).toBeGreaterThan(0);
});
