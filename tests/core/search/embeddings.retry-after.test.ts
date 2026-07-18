/**
 * Retry-After honoring and quota fail-fast (Task C2). The retry loop honors
 * a provider-supplied Retry-After delay (capped) for retriable rate-limit /
 * transient errors, while quota errors take zero retries. Pure parsing and
 * delay-computation paths are unit-tested; end-to-end honoring is proven
 * against the fake HTTP server.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import {
  OpenAICompatProvider,
  computeRetryDelayMs,
  RETRY_AFTER_CAP_MS,
} from "../../../src/core/search/embeddings/openai-compat.ts";
import { parseRetryAfterMs } from "../../../src/core/search/embeddings/http-util.ts";
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

test("parseRetryAfterMs converts delta-seconds to milliseconds", () => {
  expect(parseRetryAfterMs("5")).toBe(5000);
  expect(parseRetryAfterMs("  10  ")).toBe(10000);
  expect(parseRetryAfterMs("0")).toBe(0);
});

test("parseRetryAfterMs returns null for absent or unparseable values", () => {
  expect(parseRetryAfterMs(null)).toBeNull();
  expect(parseRetryAfterMs("")).toBeNull();
  expect(parseRetryAfterMs("soon")).toBeNull();
});

test("parseRetryAfterMs parses an HTTP-date relative to now", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const future = new Date(now + 12_000).toUTCString();
  expect(parseRetryAfterMs(future, now)).toBe(12000);
  // A past date floors at zero rather than going negative.
  const past = new Date(now - 5_000).toUTCString();
  expect(parseRetryAfterMs(past, now)).toBe(0);
});

test("computeRetryDelayMs honors Retry-After up to the cap", () => {
  expect(computeRetryDelayMs(5000, 1, [1000, 2000], RETRY_AFTER_CAP_MS)).toBe(5000);
  expect(computeRetryDelayMs(RETRY_AFTER_CAP_MS + 10_000, 1, [1000], RETRY_AFTER_CAP_MS)).toBe(
    RETRY_AFTER_CAP_MS,
  );
});

test("computeRetryDelayMs falls back to jittered exponential backoff", () => {
  const first = computeRetryDelayMs(null, 1, [1000, 2000], RETRY_AFTER_CAP_MS);
  expect(first).toBeGreaterThanOrEqual(750);
  expect(first).toBeLessThanOrEqual(1250);
  // Attempt beyond the array reuses the last base.
  const later = computeRetryDelayMs(null, 5, [1000, 2000], RETRY_AFTER_CAP_MS);
  expect(later).toBeGreaterThanOrEqual(1500);
  expect(later).toBeLessThanOrEqual(2500);
});

test("RETRY_AFTER_CAP_MS is a sane bounded cap (30s)", () => {
  expect(RETRY_AFTER_CAP_MS).toBe(30_000);
});

test("quota fails fast with zero retries regardless of maxRetries", async () => {
  server.setHandler(() => ({ status: 402, body: { error: { message: "pay up" } } }));
  const p = new OpenAICompatProvider(cfg({ maxRetries: 5 }), { backoffMs: [1, 1, 1, 1] });
  let err: SearchError | null = null;
  try {
    await p.embed(["x"]);
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_QUOTA_EXHAUSTED");
  expect(server.callCount()).toBe(1);
  expect(p.consumeRetryCount()).toBe(0);
});

test("rate-limit retry honors Retry-After instead of the configured backoff", async () => {
  let calls = 0;
  server.setHandler(() => {
    calls++;
    if (calls === 1) {
      return { status: 429, headers: { "retry-after": "0" }, body: { error: "slow down" } };
    }
    return {
      status: 200,
      body: { data: [{ object: "embedding", embedding: [1, 0, 0, 0], index: 0 }], model: "m" },
    };
  });
  // Backoff is 10s: if the loop used it instead of the 0s Retry-After the
  // test would blow past its own budget.
  const p = new OpenAICompatProvider(cfg({ maxRetries: 2, dimension: 4 }), { backoffMs: [10_000] });
  const start = Date.now();
  const out = await p.embed(["x"]);
  const elapsed = Date.now() - start;
  expect(out.length).toBe(1);
  expect(calls).toBe(2);
  expect(elapsed).toBeLessThan(2000);
});
