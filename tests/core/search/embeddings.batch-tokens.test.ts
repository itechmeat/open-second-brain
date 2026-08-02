/**
 * Per-request token budget for embedding batches (provenance-at-the-boundary,
 * unit E / t_39ec3fef).
 *
 * A batch closes on whichever fills first: the count cap
 * (`embedding_batch_size`) or the accumulated token estimate
 * (`embedding_batch_tokens`). With the budget absent, batching is
 * byte-identical to the fixed-stride behaviour that preceded it.
 *
 * The estimate is `estimateTokens` from `embeddings/signature.ts` - the
 * estimator already resident in this layer and already governing the cost
 * gate - so the gate and the budget describe the same texts identically.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chunkArray,
  chunkArrayByTokenBudget,
} from "../../../src/core/search/embeddings/http-util.ts";
import { estimateTokens } from "../../../src/core/search/embeddings/signature.ts";
import { OpenAICompatProvider } from "../../../src/core/search/embeddings/openai-compat.ts";
import { ZeroEntropyProvider } from "../../../src/core/search/embeddings/zeroentropy.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

/** 40 chars => ceil(40/4) = 10 estimated tokens. */
const TEXT_10_TOKENS = "a".repeat(40);
/** 36 chars => 9 tokens bare; 45 chars => 12 tokens once a 9-char prefix lands. */
const TEXT_9_TOKENS = "b".repeat(36);
/** 100 chars => 25 estimated tokens - larger than any budget used below. */
const TEXT_25_TOKENS = "c".repeat(100);

let server: FakeHttp;

function openAiCfg(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl: server.url,
    model: "fake-model",
    apiKey: "test-key",
    dimension: 4,
    timeoutMs: 5_000,
    // Serial batches keep the captured request order deterministic.
    concurrency: 1,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 3,
    ...overrides,
  });
}

function zeroEntropyCfg(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "zeroentropy",
    baseUrl: server.url,
    model: "zembed-1",
    apiKey: "ze-test-key",
    dimension: 4,
    timeoutMs: 5_000,
    concurrency: 1,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 3,
    ...overrides,
  });
}

/** Records each request's `input` array and answers with OpenAI-shaped vectors. */
function captureOpenAi(sent: string[][]) {
  return (req: { body: unknown }) => {
    const body = req.body as { input: string[]; model: string };
    sent.push([...body.input]);
    const data = body.input.map((t, i) => ({
      object: "embedding",
      embedding: [t.length, i, 1, 1],
      index: i,
    }));
    return { status: 200, body: { data, model: body.model } };
  };
}

/** Records each request's `input` array and answers with ZeroEntropy-shaped vectors. */
function captureZeroEntropy(sent: string[][]) {
  return (req: { method: string; path: string; body: unknown }) => {
    if (!req.path.endsWith("/models/embed") || req.method !== "POST") {
      return { status: 404, body: { error: "not_found" } };
    }
    const body = req.body as { input: string[] };
    sent.push([...body.input]);
    const results = body.input.map((text, index) => ({
      embedding: [text.length, index, 1, 1],
    }));
    return { status: 200, body: { results } };
  };
}

beforeEach(async () => {
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
});

// ── the packer itself ────────────────────────────────────────────────────────

test("chunkArrayByTokenBudget with no budget is identical to the fixed stride", () => {
  const texts = [TEXT_10_TOKENS, TEXT_9_TOKENS, TEXT_25_TOKENS, "d", ""];
  for (const size of [1, 2, 3, 32]) {
    expect(chunkArrayByTokenBudget(texts, size, undefined, (t) => t)).toEqual(
      chunkArray(texts, size),
    );
  }
});

test("a batch closes on the token budget before the count cap when the estimate fills first", () => {
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS];
  const batches = chunkArrayByTokenBudget(texts, 32, 25, (t) => t);
  expect(batches.map((b) => b.length)).toEqual([2, 2]);
  for (const b of batches) expect(estimateTokens(b)).toBeLessThanOrEqual(25);
});

test("a batch closes on the count cap when the cap fills first", () => {
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS];
  const batches = chunkArrayByTokenBudget(texts, 2, 1000, (t) => t);
  expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
});

test("an item larger than the whole budget travels alone rather than being dropped", () => {
  const texts = [TEXT_10_TOKENS, TEXT_25_TOKENS, TEXT_10_TOKENS];
  const batches = chunkArrayByTokenBudget(texts, 32, 12, (t) => t);
  expect(batches).toEqual([[TEXT_10_TOKENS], [TEXT_25_TOKENS], [TEXT_10_TOKENS]]);
  expect(batches.flat().length).toBe(texts.length);
});

test("every input appears exactly once, in order, whatever the budget", () => {
  const texts = Array.from({ length: 17 }, (_, i) => "x".repeat(i * 7));
  for (const budget of [1, 5, 13, 40, 10_000]) {
    expect(chunkArrayByTokenBudget(texts, 4, budget, (t) => t).flat()).toEqual(texts);
  }
});

// ── openai-compat provider ───────────────────────────────────────────────────

test("openai-compat with no token budget batches exactly as the count cap alone dictates", async () => {
  const sent: string[][] = [];
  server.setHandler(captureOpenAi(sent));
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS];
  await new OpenAICompatProvider(openAiCfg()).embed(texts);
  expect(sent).toEqual([texts]);
  expect(server.callCount()).toBe(1);
});

test("openai-compat closes a batch on the token budget", async () => {
  const sent: string[][] = [];
  server.setHandler(captureOpenAi(sent));
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS];
  await new OpenAICompatProvider(openAiCfg({ batchTokens: 25 })).embed(texts);
  expect(sent).toEqual([
    [TEXT_10_TOKENS, TEXT_10_TOKENS],
    [TEXT_10_TOKENS, TEXT_10_TOKENS],
  ]);
});

test("the instruction prefix counts against the token budget", async () => {
  const texts = [TEXT_9_TOKENS, TEXT_9_TOKENS, TEXT_9_TOKENS, TEXT_9_TOKENS];
  const budget = 38;

  // Bare: 4 x 9 = 36 tokens, inside the budget -> one request.
  const bare: string[][] = [];
  server.setHandler(captureOpenAi(bare));
  await new OpenAICompatProvider(openAiCfg({ batchTokens: budget })).embed(texts, "passage");
  expect(bare.map((b) => b.length)).toEqual([4]);

  // With a 9-char prefix each text estimates at 12 tokens, so the fourth
  // no longer fits and the batch closes at three.
  const prefixed: string[][] = [];
  server.setHandler(captureOpenAi(prefixed));
  await new OpenAICompatProvider(
    openAiCfg({ batchTokens: budget, passagePrefix: "passage: " }),
  ).embed(texts, "passage");
  expect(prefixed.map((b) => b.length)).toEqual([3, 1]);
  for (const b of prefixed) {
    for (const t of b) expect(t.startsWith("passage: ")).toBe(true);
    expect(estimateTokens(b)).toBeLessThanOrEqual(budget);
  }
});

test("openai-compat still returns every vector in input order under a budget", async () => {
  server.setHandler(captureOpenAi([]));
  const texts = [TEXT_10_TOKENS, TEXT_25_TOKENS, TEXT_9_TOKENS];
  const out = await new OpenAICompatProvider(openAiCfg({ batchTokens: 12 })).embed(texts);
  expect(out.length).toBe(3);
  for (const v of out) expect(v.length).toBe(4);
});

// ── zeroentropy provider ─────────────────────────────────────────────────────

test("zeroentropy with no token budget batches exactly as the count cap alone dictates", async () => {
  const sent: string[][] = [];
  server.setHandler(captureZeroEntropy(sent));
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS];
  await new ZeroEntropyProvider(zeroEntropyCfg()).embed(texts);
  expect(sent).toEqual([texts]);
});

test("zeroentropy closes a batch on the token budget", async () => {
  const sent: string[][] = [];
  server.setHandler(captureZeroEntropy(sent));
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS];
  const out = await new ZeroEntropyProvider(zeroEntropyCfg({ batchTokens: 25 })).embed(texts);
  expect(sent).toEqual([
    [TEXT_10_TOKENS, TEXT_10_TOKENS],
    [TEXT_10_TOKENS, TEXT_10_TOKENS],
  ]);
  expect(out.length).toBe(4);
});

// ── config resolution ────────────────────────────────────────────────────────

const CONFIG_ENV_KEYS = [
  "OPEN_SECOND_BRAIN_EMBEDDING_BATCH",
  "OPEN_SECOND_BRAIN_EMBEDDING_BATCH_TOKENS",
] as const;

let vault: string;
let configPath: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-batch-tokens-"));
  configPath = join(vault, "_brain.yaml");
  savedEnv = {};
  for (const k of CONFIG_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of CONFIG_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(vault, { recursive: true, force: true });
});

test("with embedding_batch_tokens absent the resolved embedding config is byte-identical", () => {
  writeFileSync(configPath, `vault: "${vault}"\n`);
  const semantic = resolveSearchConfig({ vault, configPath }).semantic;
  // Absence is absence: the key is not present at all, so JSON round-trips
  // and key-order-sensitive consumers see exactly the pre-feature object.
  expect("batchTokens" in semantic).toBe(false);
  expect(semantic.batchTokens).toBeUndefined();
  expect(Object.keys(semantic)).toEqual([
    "enabled",
    "provider",
    "baseUrl",
    "model",
    "apiKey",
    "apiKeys",
    "dimension",
    "timeoutMs",
    "concurrency",
    "batchSize",
    "maxRetries",
    "costGateUsd",
    "queryPrefix",
    "passagePrefix",
  ]);
  expect(JSON.stringify(semantic)).not.toContain("batchTokens");
});

test("embedding_batch_tokens resolves from config and env overrides config", () => {
  writeFileSync(configPath, `vault: "${vault}"\nembedding_batch_tokens: "5000"\n`);
  expect(resolveSearchConfig({ vault, configPath }).semantic.batchTokens).toBe(5000);

  process.env["OPEN_SECOND_BRAIN_EMBEDDING_BATCH_TOKENS"] = "7000";
  expect(resolveSearchConfig({ vault, configPath }).semantic.batchTokens).toBe(7000);
});

test("a very large embedding_batch_tokens resolves to the number the operator wrote", () => {
  writeFileSync(configPath, `vault: "${vault}"\nembedding_batch_tokens: "${OVER_INT32_CAP}"\n`);
  expect(resolveSearchConfig({ vault, configPath }).semantic.batchTokens).toBe(OVER_INT32_CAP);
});

test("a fractional integer field is refused at config load, whatever its source", () => {
  // The string path already refuses it; a programmatic override must too,
  // or the packer downstream is handed a cap it cannot step by.
  writeFileSync(configPath, `vault: "${vault}"\nembedding_batch_tokens: "2.5"\n`);
  expect(() => resolveSearchConfig({ vault, configPath })).toThrow(/embedding_batch_tokens/);
  writeFileSync(configPath, `vault: "${vault}"\n`);
  expect(() =>
    resolveSearchConfig({ vault, configPath, overrides: { semantic: { batchTokens: 2.5 } } }),
  ).toThrow(/embedding_batch_tokens/);
  expect(() =>
    resolveSearchConfig({ vault, configPath, overrides: { semantic: { batchSize: 2.5 } } }),
  ).toThrow(/embedding_batch_size/);
});

test("embedding_batch_tokens is rejected at zero as a string, like embedding_batch_size", () => {
  for (const key of ["embedding_batch_size", "embedding_batch_tokens"]) {
    writeFileSync(configPath, `vault: "${vault}"\n${key}: "0"\n`);
    expect(() => resolveSearchConfig({ vault, configPath })).toThrow(key);
  }
});

// ── caps beyond the 32-bit boundary ──────────────────────────────────────────

/**
 * Above 2^31-1. `Math.max(1, n | 0)` used to truncate a cap this size into a
 * NEGATIVE int32 and then lift it to 1, so the largest budget an operator can
 * ask for became the smallest one possible: a batch that closes after every
 * item, i.e. one HTTP request per chunk at full concurrency.
 */
const OVER_INT32_CAP = 3_000_000_000;

test("a token budget above the 32-bit boundary is honoured, not truncated", () => {
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS];
  expect(chunkArrayByTokenBudget(texts, 32, OVER_INT32_CAP, (t) => t)).toEqual([texts]);
});

test("a count cap above the 32-bit boundary is honoured, not truncated", () => {
  const texts = [TEXT_10_TOKENS, TEXT_9_TOKENS, TEXT_25_TOKENS];
  expect(chunkArray(texts, OVER_INT32_CAP)).toEqual([texts]);
  expect(chunkArrayByTokenBudget(texts, OVER_INT32_CAP, 10_000, (t) => t)).toEqual([texts]);
});

test("openai-compat sends one request for a budget no batch can exhaust", async () => {
  const sent: string[][] = [];
  server.setHandler(captureOpenAi(sent));
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS, TEXT_10_TOKENS];
  await new OpenAICompatProvider(openAiCfg({ batchTokens: OVER_INT32_CAP })).embed(texts);
  expect(sent).toEqual([texts]);
  expect(server.callCount()).toBe(1);
});

test("a cap that cannot be honoured is refused, never quietly reinterpreted", () => {
  const texts = [TEXT_10_TOKENS, TEXT_10_TOKENS];
  for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => chunkArrayByTokenBudget(texts, 32, bad, (t) => t)).toThrow(/token budget/);
    expect(() => chunkArray(texts, bad)).toThrow(/batch size/);
  }
});

test("embedding_batch_tokens is rejected at zero as a programmatic override", () => {
  writeFileSync(configPath, `vault: "${vault}"\n`);
  expect(() =>
    resolveSearchConfig({ vault, configPath, overrides: { semantic: { batchTokens: 0 } } }),
  ).toThrow(/embedding_batch_tokens/);
  expect(() =>
    resolveSearchConfig({ vault, configPath, overrides: { semantic: { batchTokens: -1 } } }),
  ).toThrow(/embedding_batch_tokens/);
  expect(() =>
    resolveSearchConfig({
      vault,
      configPath,
      overrides: { semantic: { batchTokens: Number.NaN } },
    }),
  ).toThrow(/embedding_batch_tokens/);
});
