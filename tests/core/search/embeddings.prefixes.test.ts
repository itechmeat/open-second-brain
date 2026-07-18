import { test, expect, beforeEach, afterEach } from "bun:test";

import { OpenAICompatProvider } from "../../../src/core/search/embeddings/openai-compat.ts";
import {
  isE5FamilyModel,
  resolveEmbeddingPrefixes,
  findEmbeddingPreset,
} from "../../../src/core/search/embeddings/presets.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

let server: FakeHttp;

function cfg(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl: server.url,
    model: "fake-model",
    apiKey: "test-key",
    dimension: 4,
    timeoutMs: 5_000,
    concurrency: 2,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 3,
    ...overrides,
  });
}

function captureInputHandler(captured: string[]) {
  return (req: { body: unknown }) => {
    const body = req.body as { input: string[]; model: string };
    for (const t of body.input) captured.push(t);
    const data = body.input.map((t, i) => ({
      object: "embedding",
      embedding: [t.length, i, 1, 1],
      index: i,
    }));
    return { status: 200, body: { data, model: body.model } };
  };
}

beforeEach(async () => {
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
});

// ── preset / structural resolution ───────────────────────────────────────────

test("isE5FamilyModel matches e5 model ids structurally, not by prose", () => {
  expect(isE5FamilyModel("intfloat/multilingual-e5-small")).toBe(true);
  expect(isE5FamilyModel("intfloat/e5-large-v2")).toBe(true);
  expect(isE5FamilyModel("intfloat/multilingual-e5-large-instruct")).toBe(true);
  expect(isE5FamilyModel("BAAI/bge-m3")).toBe(false);
  expect(isE5FamilyModel("text-embedding-3-small")).toBe(false);
  expect(isE5FamilyModel("acme/e5x-weird")).toBe(false);
});

test("the shipped e5 preset carries the query/passage prefixes", () => {
  const preset = findEmbeddingPreset("intfloat/multilingual-e5-small");
  expect(preset?.queryPrefix).toBe("query: ");
  expect(preset?.passagePrefix).toBe("passage: ");
});

test("resolveEmbeddingPrefixes defaults to the e5 prefixes for an e5 model", () => {
  expect(resolveEmbeddingPrefixes("intfloat/multilingual-e5-small", null, null)).toEqual({
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
  });
});

test("resolveEmbeddingPrefixes yields empty prefixes for a non-e5 model with no config", () => {
  expect(resolveEmbeddingPrefixes("text-embedding-3-small", null, null)).toEqual({
    queryPrefix: "",
    passagePrefix: "",
  });
  expect(resolveEmbeddingPrefixes(null, null, null)).toEqual({
    queryPrefix: "",
    passagePrefix: "",
  });
});

test("config overrides win over preset defaults", () => {
  expect(resolveEmbeddingPrefixes("intfloat/multilingual-e5-small", "q> ", "p> ")).toEqual({
    queryPrefix: "q> ",
    passagePrefix: "p> ",
  });
});

test("an explicit empty-string override disables a preset prefix", () => {
  expect(resolveEmbeddingPrefixes("intfloat/multilingual-e5-small", "", "")).toEqual({
    queryPrefix: "",
    passagePrefix: "",
  });
});

// ── provider boundary ────────────────────────────────────────────────────────

test("embed(texts, 'passage') prepends the configured passage prefix", async () => {
  const captured: string[] = [];
  server.setHandler(captureInputHandler(captured));
  const p = new OpenAICompatProvider(cfg({ queryPrefix: "query: ", passagePrefix: "passage: " }));
  await p.embed(["hello", "world"], "passage");
  expect(captured).toEqual(["passage: hello", "passage: world"]);
});

test("embed(texts, 'query') prepends the configured query prefix", async () => {
  const captured: string[] = [];
  server.setHandler(captureInputHandler(captured));
  const p = new OpenAICompatProvider(cfg({ queryPrefix: "query: ", passagePrefix: "passage: " }));
  await p.embed(["find me"], "query");
  expect(captured).toEqual(["query: find me"]);
});

test("embed(texts) with no kind sends the texts byte-identical (backward compatible)", async () => {
  const captured: string[] = [];
  server.setHandler(captureInputHandler(captured));
  const p = new OpenAICompatProvider(cfg({ queryPrefix: "query: ", passagePrefix: "passage: " }));
  await p.embed(["untouched"]);
  expect(captured).toEqual(["untouched"]);
});

test("an empty prefix leaves the input byte-identical even when a kind is passed", async () => {
  const captured: string[] = [];
  server.setHandler(captureInputHandler(captured));
  const p = new OpenAICompatProvider(cfg({ queryPrefix: "", passagePrefix: "" }));
  await p.embed(["a"], "passage");
  await p.embed(["b"], "query");
  expect(captured).toEqual(["a", "b"]);
});
