/**
 * No provider transport follows a redirect (audit M9).
 *
 * Every embedding and rerank request carries `authorization: Bearer` and
 * vault text. The fetch default is `redirect: "follow"`, which would hand
 * both to whatever host a 3xx names - the plain-http hop included. Each of
 * the three transports sets `redirect: "error"`, so a redirecting endpoint
 * fails the request and the redirect target never sees it.
 *
 * Driven against a real local server: the endpoint answers 307 to a
 * `/stolen` path on the same server, and the assertion is that `/stolen`
 * was never requested.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { OpenAICompatProvider } from "../../../src/core/search/embeddings/openai-compat.ts";
import { ZeroEntropyProvider } from "../../../src/core/search/embeddings/zeroentropy.ts";
import { CrossEncoderRerankProvider } from "../../../src/core/search/rerank/cross-encoder.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

let server: FakeHttp;
let stolen: Array<{ path: string; auth: string }>;

beforeEach(async () => {
  server = await startFakeHttp();
  stolen = [];
  server.setHandler((req) => {
    if (req.path.endsWith("/stolen")) {
      stolen.push({ path: req.path, auth: req.headers["authorization"] ?? "" });
      return { status: 200, body: {} };
    }
    return { status: 307, headers: { location: `${server.url}/stolen` }, body: {} };
  });
});

afterEach(async () => {
  await server.close();
});

function cfg(provider: "openai-compat" | "zeroentropy"): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider,
    baseUrl: server.url,
    model: "m",
    apiKey: "redirect-test-key",
    dimension: null,
    timeoutMs: 5_000,
    concurrency: 1,
    batchSize: 8,
    costGateUsd: 0,
    maxRetries: 1,
  });
}

test("openai-compat embeddings do not follow a redirect", async () => {
  const p = new OpenAICompatProvider(cfg("openai-compat"), { backoffMs: [1] });
  await expect(p.embed(["vault text"])).rejects.toThrow();
  expect(server.callCount()).toBeGreaterThan(0);
  expect(stolen).toEqual([]);
});

test("zeroentropy embeddings do not follow a redirect", async () => {
  const p = new ZeroEntropyProvider(cfg("zeroentropy"), { backoffMs: [1] });
  await expect(p.embed(["vault text"])).rejects.toThrow();
  expect(server.callCount()).toBeGreaterThan(0);
  expect(stolen).toEqual([]);
});

test("the cross-encoder reranker does not follow a redirect", async () => {
  const p = new CrossEncoderRerankProvider({
    baseUrl: server.url,
    model: "r",
    apiKey: "redirect-test-key",
  });
  await expect(p.rerank("query", ["doc"])).rejects.toThrow();
  expect(server.callCount()).toBeGreaterThan(0);
  expect(stolen).toEqual([]);
});
