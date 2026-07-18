/**
 * Quota/billing error classification (Task C1). HTTP 402 always denotes an
 * exhausted embedding quota; HTTP 429 denotes quota ONLY when the response
 * body carries a protocol-token evidence (provider error `code`/`type` such
 * as `insufficient_quota` or a `billing_*` code). Quota errors are
 * non-retriable and carry an actionable billing message; plain 429 stays a
 * retriable rate-limit.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import {
  OpenAICompatProvider,
  classifyEmbeddingError,
} from "../../../src/core/search/embeddings/openai-compat.ts";
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
    costGateUsd: 0,
    maxRetries: 5,
    ...overrides,
  });
}

beforeEach(async () => {
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
});

async function embedExpectingError(p: OpenAICompatProvider): Promise<SearchError> {
  try {
    await p.embed(["x"]);
  } catch (e) {
    return e as SearchError;
  }
  throw new Error("expected embed to throw");
}

test("HTTP 402 classifies as EMBEDDING_QUOTA_EXHAUSTED and does not retry", async () => {
  server.setHandler(() => ({ status: 402, body: { error: { message: "payment required" } } }));
  const p = new OpenAICompatProvider(cfg(), { backoffMs: [1, 1] });
  const err = await embedExpectingError(p);
  expect(err.code).toBe("EMBEDDING_QUOTA_EXHAUSTED");
  expect(err.status).toBe(402);
  expect(err.message).toMatch(/quota|billing/i);
  expect(server.callCount()).toBe(1);
});

test("HTTP 402 exposes a parsed Retry-After seconds value as milliseconds", async () => {
  server.setHandler(() => ({
    status: 402,
    headers: { "retry-after": "7" },
    body: { error: { message: "payment required" } },
  }));
  const p = new OpenAICompatProvider(cfg(), { backoffMs: [1, 1] });
  const err = await embedExpectingError(p);
  expect(err.code).toBe("EMBEDDING_QUOTA_EXHAUSTED");
  expect(err.retryAfterMs).toBe(7000);
});

test("HTTP 429 with insufficient_quota body classifies as quota (no retry)", async () => {
  server.setHandler(() => ({
    status: 429,
    body: { error: { code: "insufficient_quota", message: "exceeded" } },
  }));
  const p = new OpenAICompatProvider(cfg(), { backoffMs: [1, 1] });
  const err = await embedExpectingError(p);
  expect(err.code).toBe("EMBEDDING_QUOTA_EXHAUSTED");
  expect(err.status).toBe(429);
  expect(server.callCount()).toBe(1);
});

test("HTTP 429 with a billing_* error type classifies as quota", async () => {
  server.setHandler(() => ({
    status: 429,
    body: { error: { type: "billing_hard_limit_reached" } },
  }));
  const p = new OpenAICompatProvider(cfg(), { backoffMs: [1, 1] });
  const err = await embedExpectingError(p);
  expect(err.code).toBe("EMBEDDING_QUOTA_EXHAUSTED");
  expect(server.callCount()).toBe(1);
});

test("plain HTTP 429 without quota evidence stays a retriable rate-limit", async () => {
  server.setHandler(() => ({ status: 429, body: { error: "rate limited" } }));
  const p = new OpenAICompatProvider(cfg({ maxRetries: 2 }), { backoffMs: [1] });
  const err = await embedExpectingError(p);
  expect(err.code).toBe("EMBEDDING_PROVIDER_HTTP");
  expect(err.message).toContain("429");
  expect(server.callCount()).toBe(2);
});

test("classifyEmbeddingError maps a quota error to a non-retriable quota category", () => {
  const e = new SearchError("EMBEDDING_QUOTA_EXHAUSTED", "billing exhausted", {
    status: 402,
    retryAfterMs: 5000,
  });
  const cls = classifyEmbeddingError(e);
  expect(cls.category).toBe("quota");
  expect(cls.retriable).toBe(false);
  expect(cls.retryAfterMs).toBe(5000);
  expect(cls.error).toBe(e);
});

test("classifyEmbeddingError maps HTTP statuses to categories", () => {
  const cases: Array<{ status: number; category: string; retriable: boolean }> = [
    { status: 429, category: "rate_limit", retriable: true },
    { status: 500, category: "transient", retriable: true },
    { status: 503, category: "transient", retriable: true },
    { status: 401, category: "auth", retriable: false },
    { status: 403, category: "auth", retriable: false },
    { status: 400, category: "fatal", retriable: false },
  ];
  for (const c of cases) {
    const e = new SearchError("EMBEDDING_PROVIDER_HTTP", `embedding HTTP ${c.status}`, {
      status: c.status,
    });
    const cls = classifyEmbeddingError(e);
    expect(cls.category).toBe(c.category as never);
    expect(cls.retriable).toBe(c.retriable);
  }
});

test("classifyEmbeddingError treats timeouts and network errors as transient", () => {
  const timeout = new SearchError("EMBEDDING_PROVIDER_TIMEOUT", "timed out");
  expect(classifyEmbeddingError(timeout).category).toBe("transient");
  expect(classifyEmbeddingError(timeout).retriable).toBe(true);

  // No status = network error.
  const network = new SearchError("EMBEDDING_PROVIDER_HTTP", "network error: reset");
  expect(classifyEmbeddingError(network).category).toBe("transient");
  expect(classifyEmbeddingError(network).retriable).toBe(true);
});

test("classifyEmbeddingError carries the parsed Retry-After through", () => {
  const e = new SearchError("EMBEDDING_PROVIDER_HTTP", "embedding HTTP 429", {
    status: 429,
    retryAfterMs: 1500,
  });
  expect(classifyEmbeddingError(e).retryAfterMs).toBe(1500);
});
