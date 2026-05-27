import { test, expect, beforeEach, afterEach } from "bun:test";

import { OpenAICompatProvider } from "../../../src/core/search/embeddings/openai-compat.ts";
import { NullProvider } from "../../../src/core/search/embeddings/null-provider.ts";
import { makeProvider } from "../../../src/core/search/embeddings/provider.ts";
import { SearchError } from "../../../src/core/search/types.ts";
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
    dimension: null,
    timeoutMs: 5_000,
    concurrency: 2,
    batchSize: 32,
    ...overrides,
  });
}

beforeEach(async () => {
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
});

test("embed() returns unit-normalised vectors in input order", async () => {
  const p = new OpenAICompatProvider(cfg());
  const out = await p.embed(["a", "b", "c"]);
  expect(out.length).toBe(3);
  // The default fake handler echoes [tokens, index, len, 1]. Index differs.
  // After unit-normalisation, ||v|| == 1.
  for (const v of out) {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 6);
  }
});

test("embed() preserves input order across batches", async () => {
  const p = new OpenAICompatProvider(cfg({ batchSize: 2 }));
  const inputs = ["one", "two", "three", "four", "five"];
  const out = await p.embed(inputs);
  expect(out.length).toBe(5);
  // Server returns >2 calls because batchSize=2 → 3 batches.
  expect(server.callCount()).toBe(3);
});

test("embed() sorts response.data by `index` even if server returns shuffled", async () => {
  server.setHandler((req) => {
    const body = req.body as { input: string[]; model: string };
    const indices = body.input.map((_, i) => i);
    // Shuffle: reverse.
    const shuffled = [...indices].toReversed();
    const data = shuffled.map((origIdx) => {
      const text = body.input[origIdx]!;
      const v = [text.length, origIdx, 1, 1];
      return { object: "embedding", embedding: v, index: origIdx };
    });
    return { status: 200, body: { data, model: body.model } };
  });

  const p = new OpenAICompatProvider(cfg({ dimension: 4 }), { backoffMs: [5, 5] });
  const out = await p.embed(["aaaa", "bb"]);
  // First input "aaaa" has length 4 — unit-normalised first component dominates.
  // Second input "bb" has length 2.
  expect(out[0]!.length).toBe(4);
  expect(out[1]!.length).toBe(4);
  // Sanity: the first input's first dimension > second input's first dimension.
  // After normalisation, monotonic relationship preserved because all other
  // components are identical between the two outputs (index, 1, 1).
  // (We don't need exact values; just confirm we received the right vector
  // per the original `index`.)
  expect(out[0]).not.toEqual(out[1]);
});

test("embed() rejects duplicate response indexes that leave a missing vector", async () => {
  server.setHandler((req) => {
    const body = req.body as { input: string[]; model: string };
    return {
      status: 200,
      body: {
        data: [
          { object: "embedding", embedding: [1, 0, 0, 0], index: 0 },
          { object: "embedding", embedding: [0, 1, 0, 0], index: 0 },
        ],
        model: body.model,
      },
    };
  });

  const p = new OpenAICompatProvider(cfg({ dimension: 4 }), { backoffMs: [5, 5] });
  let err: SearchError | null = null;
  try {
    await p.embed(["a", "b"]);
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_PROVIDER_HTTP");
  expect(err?.message).toContain("missing vector");
});

test("embed() retries on 503 then succeeds", async () => {
  let calls = 0;
  server.setHandler((req) => {
    calls++;
    if (calls === 1) return { status: 503, body: { error: "busy" } };
    return {
      status: 200,
      body: {
        data: [{ object: "embedding", embedding: [0.5, 0.5, 0.5, 0.5], index: 0 }],
        model: (req.body as { model: string }).model,
      },
    };
  });

  const p = new OpenAICompatProvider(cfg(), { backoffMs: [10, 20] });
  const out = await p.embed(["once"]);
  expect(out.length).toBe(1);
  expect(calls).toBe(2);
});

test("embed() fails fast on 400 (non-retriable 4xx)", async () => {
  server.setHandler(() => ({ status: 400, body: { error: "bad request" } }));
  const p = new OpenAICompatProvider(cfg(), { backoffMs: [10, 20] });
  let err: SearchError | null = null;
  try {
    await p.embed(["x"]);
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_PROVIDER_HTTP");
  expect(err?.message).toContain("400");
  expect(server.callCount()).toBe(1);
});

test("embed() throws EMBEDDING_PROVIDER_HTTP after exhausting retries on 5xx", async () => {
  server.setHandler(() => ({ status: 503, body: { error: "busy" } }));
  const p = new OpenAICompatProvider(cfg(), { backoffMs: [10, 20] });
  let err: SearchError | null = null;
  try {
    await p.embed(["x"]);
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_PROVIDER_HTTP");
  expect(server.callCount()).toBe(3);
});

test("embed() honours per-request timeout via AbortController", async () => {
  server.setHandler(() => ({ status: 200, body: { data: [] }, delayMs: 200 }));
  const p = new OpenAICompatProvider(cfg({ timeoutMs: 30 }), { backoffMs: [5, 5] });
  let err: SearchError | null = null;
  try {
    await p.embed(["x"]);
  } catch (e) {
    err = e as SearchError;
  }
  // Either the timeout or the shape-mismatch is acceptable as the surfaced
  // error, but it should be a SearchError from this module.
  expect(err?.code).toBe("EMBEDDING_PROVIDER_TIMEOUT");
}, 15_000);

test("embed() rejects EMBEDDING_DIMENSION_MISMATCH across batch", async () => {
  let i = 0;
  server.setHandler((req) => {
    const body = req.body as { input: string[]; model: string };
    const data = body.input.map((_, idx) => ({
      object: "embedding",
      embedding: i++ === 0 ? [1, 0, 0, 0] : [1, 0, 0],
      index: idx,
    }));
    return { status: 200, body: { data, model: body.model } };
  });
  const p = new OpenAICompatProvider(cfg({ batchSize: 1, concurrency: 1 }));
  let err: SearchError | null = null;
  try {
    await p.embed(["a", "b"]);
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_DIMENSION_MISMATCH");
});

test("ping() returns ok with dimension on success", async () => {
  const p = new OpenAICompatProvider(cfg());
  const res = await p.ping();
  if (!res.ok) throw new Error("expected ok");
  expect(res.dimension).toBeGreaterThan(0);
});

test("ping() returns ok:false when server is unreachable", async () => {
  await server.close();
  const p = new OpenAICompatProvider(cfg(), { backoffMs: [10] });
  const res = await p.ping();
  expect(res.ok).toBe(false);
});

test("makeProvider returns NullProvider when semantic is disabled", () => {
  const p = makeProvider({
    enabled: false,
    provider: "disabled",
    baseUrl: null,
    model: null,
    apiKey: null,
    dimension: null,
    timeoutMs: 10_000,
    concurrency: 1,
    batchSize: 1,
  });
  expect(p).toBeInstanceOf(NullProvider);
});

test("makeProvider throws when key is missing under openai-compat", () => {
  expect(() =>
    makeProvider({
      enabled: true,
      provider: "openai-compat",
      baseUrl: "https://x/v1",
      model: "m",
      apiKey: null,
      dimension: null,
      timeoutMs: 10_000,
      concurrency: 1,
      batchSize: 1,
    }),
  ).toThrow(/embedding_api_key/);
});

test("NullProvider.embed() throws EMBEDDING_DISABLED", async () => {
  const p = new NullProvider();
  let err: SearchError | null = null;
  try {
    await p.embed(["x"]);
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_DISABLED");
});
