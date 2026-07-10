import { test, expect, beforeEach, afterEach } from "bun:test";

import { ZeroEntropyProvider } from "../../../src/core/search/embeddings/zeroentropy.ts";
import { makeProvider } from "../../../src/core/search/embeddings/provider.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

let server: FakeHttp;

function cfg(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "zeroentropy",
    baseUrl: server.url,
    model: "zembed-1",
    apiKey: "ze-test-key",
    dimension: null,
    timeoutMs: 5_000,
    concurrency: 2,
    batchSize: 32,
    costGateUsd: 0,
    ...overrides,
  });
}

/** ZeroEntropy-shaped handler: POST /models/embed -> {results:[{embedding}]}. */
function zeHandler(dim = 4) {
  return (req: {
    method: string;
    path: string;
    body: unknown;
  }): { status: number; body: unknown } => {
    if (!req.path.endsWith("/models/embed") || req.method !== "POST") {
      return { status: 404, body: { error: "not_found" } };
    }
    const body = req.body as { input: string[]; dimensions?: number };
    const width = body.dimensions ?? dim;
    const results = body.input.map((text, index) => ({
      // Deterministic vector: leading component from length, then index.
      embedding: [text.length, index, ...new Array(Math.max(0, width - 2)).fill(1)],
    }));
    return { status: 200, body: { results, usage: { total_bytes: 1, total_tokens: 1 } } };
  };
}

beforeEach(async () => {
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
});

test("embed() returns unit-normalised vectors in input order", async () => {
  server.setHandler(zeHandler(4));
  const p = new ZeroEntropyProvider(cfg({ dimension: 4 }));
  const out = await p.embed(["aaaa", "bb", "c"]);
  expect(out.length).toBe(3);
  for (const v of out) {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 6);
  }
  // First input longest -> largest leading component before normalisation.
  expect(out[0]![0]).toBeGreaterThan(out[2]![0]!);
});

test("embed() sends Bearer auth and the native request body", async () => {
  let seenAuth = "";
  let seenBody: Record<string, unknown> = {};
  server.setHandler((req) => {
    seenAuth = req.headers["authorization"] ?? "";
    seenBody = req.body as Record<string, unknown>;
    const body = req.body as { input: string[] };
    return {
      status: 200,
      body: { results: body.input.map(() => ({ embedding: [1, 0, 0, 0] })) },
    };
  });
  const p = new ZeroEntropyProvider(cfg({ dimension: 4 }));
  await p.embed(["x"]);
  expect(seenAuth).toBe("Bearer ze-test-key");
  expect(seenBody["model"]).toBe("zembed-1");
  expect(seenBody["input_type"]).toBe("document");
  expect(seenBody["input"]).toEqual(["x"]);
});

test("embed() forwards a configured dimension to the API", async () => {
  let seenDim: unknown;
  server.setHandler((req) => {
    seenDim = (req.body as { dimensions?: number }).dimensions;
    return zeHandler(640)(req);
  });
  const p = new ZeroEntropyProvider(cfg({ dimension: 640 }));
  const out = await p.embed(["x"]);
  expect(seenDim).toBe(640);
  expect(out[0]!.length).toBe(640);
});

test("ping() returns ok with dimension", async () => {
  server.setHandler(zeHandler(4));
  const p = new ZeroEntropyProvider(cfg({ dimension: 4 }));
  const res = await p.ping();
  if (!res.ok) throw new Error("expected ok");
  expect(res.dimension).toBe(4);
});

test("embed() retries on 503 then succeeds", async () => {
  let calls = 0;
  server.setHandler((req) => {
    calls++;
    if (calls === 1) return { status: 503, body: { error: "busy" } };
    return zeHandler(4)(req);
  });
  const p = new ZeroEntropyProvider(cfg({ dimension: 4 }), { backoffMs: [10, 20] });
  const out = await p.embed(["once"]);
  expect(out.length).toBe(1);
  expect(calls).toBe(2);
});

test("makeProvider returns a ZeroEntropyProvider for provider 'zeroentropy'", () => {
  const p = makeProvider(cfg({ dimension: 4 }));
  expect(p).toBeInstanceOf(ZeroEntropyProvider);
  expect(p.name).toBe("zeroentropy");
});

test("makeProvider throws EMBEDDING_KEY_MISSING when key absent", () => {
  expect(() => makeProvider(cfg({ apiKey: null }))).toThrow(SearchError);
});
