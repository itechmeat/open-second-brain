import { test, expect } from "bun:test";

import {
  LocalProvider,
  LOCAL_DEFAULT_DIMENSION,
} from "../../../src/core/search/embeddings/local-provider.ts";
import { makeProvider } from "../../../src/core/search/embeddings/provider.ts";
import { LOCAL_EMBEDDING_MODEL } from "../../../src/core/search/embeddings/signature.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";

function norm(v: ReadonlyArray<number>): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

test("identifies as the local provider with the hashing model", () => {
  const p = new LocalProvider(256);
  expect(p.name).toBe("local");
  expect(p.model).toBe(LOCAL_EMBEDDING_MODEL);
  expect(p.dimension).toBe(256);
});

test("default dimension is applied when none is configured", () => {
  const p = new LocalProvider();
  expect(p.dimension).toBe(LOCAL_DEFAULT_DIMENSION);
});

test("produces one unit-normalised vector per input, in order", async () => {
  const p = new LocalProvider(128);
  const out = await p.embed(["alpha beta", "gamma delta", "epsilon"]);
  expect(out.length).toBe(3);
  for (const v of out) {
    expect(v.length).toBe(128);
    expect(norm(v)).toBeCloseTo(1.0, 6);
  }
});

test("is deterministic: identical text yields an identical vector", async () => {
  const p = new LocalProvider(64);
  const [a] = await p.embed(["the quick brown fox"]);
  const [b] = await p.embed(["the quick brown fox"]);
  expect(a).toEqual(b!);
});

test("distinct text yields distinct vectors", async () => {
  const p = new LocalProvider(64);
  const [a, b] = await p.embed(["machine learning", "garden vegetables"]);
  expect(a).not.toEqual(b!);
});

test("empty text yields a zero vector of the right length", async () => {
  const p = new LocalProvider(32);
  const [v] = await p.embed([""]);
  expect(v!.length).toBe(32);
  expect(norm(v!)).toBe(0);
});

test("embed() with no inputs returns an empty array", async () => {
  const p = new LocalProvider();
  expect(await p.embed([])).toEqual([]);
});

test("ping() always succeeds offline with the configured dimension", async () => {
  const p = new LocalProvider(200);
  const res = await p.ping();
  expect(res).toEqual({ ok: true, dimension: 200 });
});

test("makeProvider returns a LocalProvider for provider 'local'", () => {
  const config: ResolvedEmbeddingConfig = Object.freeze({
    enabled: true,
    provider: "local",
    baseUrl: null,
    model: null,
    apiKey: null,
    dimension: 384,
    timeoutMs: 10_000,
    concurrency: 1,
    batchSize: 1,
    costGateUsd: 0,
    maxRetries: 3,
  });
  const p = makeProvider(config);
  expect(p).toBeInstanceOf(LocalProvider);
  expect(p.dimension).toBe(384);
  expect(p.model).toBe(LOCAL_EMBEDDING_MODEL);
});

test("makeProvider local needs no api key", () => {
  const config: ResolvedEmbeddingConfig = Object.freeze({
    enabled: true,
    provider: "local",
    baseUrl: null,
    model: null,
    apiKey: null,
    dimension: null,
    timeoutMs: 10_000,
    concurrency: 1,
    batchSize: 1,
    costGateUsd: 0,
    maxRetries: 3,
  });
  expect(() => makeProvider(config)).not.toThrow();
  expect(makeProvider(config).dimension).toBe(LOCAL_DEFAULT_DIMENSION);
});
