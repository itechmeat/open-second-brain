/**
 * Cross-encoder rerank wired through `search()`
 * (retrieval-precision-quality-loop, card A / t_110867f5).
 *
 * End-to-end: config-enabled rerank widens the candidate pool, calls the
 * OpenAI-compatible `/rerank` endpoint (stubbed `fetch`), and re-orders
 * the final window. Disabled stays byte-identical; enabled-but-unconfigured
 * fails closed; an endpoint error degrades gracefully with a warning.
 */

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { LocalRerankProvider } from "../../../src/core/search/rerank/local.ts";
import {
  describeRetrievalDegradation,
  RETRIEVAL_DEGRADATION,
} from "../../../src/core/search/retrieval-trail.ts";
import { search } from "../../../src/core/search/search.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

const realFetch = globalThis.fetch;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("rerank-search"));
  writeMd(vault, "strong.md", "# Strong\n\nfox fox fox fox the quick brown fox jumps high.");
  writeMd(vault, "weak.md", "# Weak\n\nA note mostly about cats, with one fox mention here.");
  writeMd(vault, "mid.md", "# Mid\n\nThe fox and the hound; a fox story about foxes.");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

const ENABLED = {
  enabled: true,
  baseUrl: "https://api.example.com/v1",
  model: "rerank-1",
  apiKey: "secret",
  topK: 10,
} as const;

/** Score the document containing `winner` highest, everything else low. */
function stubRerankFetch(winner: string): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { documents: string[] };
    const results = body.documents.map((doc, index) => ({
      index,
      relevance_score: doc.includes(winner) ? 0.99 : 0.01,
    }));
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("disabled (default) is byte-identical to the pre-feature baseline", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
  const base = await search(cfg, { query: "fox", limit: 10 });
  expect(called).toBe(false); // zero HTTP cost when disabled
  expect(base.results.length).toBeGreaterThanOrEqual(3);
  // The heuristic ranker puts the dense "strong" hit first.
  expect(base.results[0]!.path).toBe("strong.md");
});

test("enabled: the cross-encoder's top-scored doc lands first", async () => {
  const cfg = makeConfig({ vault, dbPath, rerank: ENABLED });
  await indexVault(cfg);
  // Promote the "cats" note (weak.md) that the heuristic ranker placed low.
  stubRerankFetch("cats");
  const out = await search(cfg, { query: "fox", limit: 10 });
  expect(out.results[0]!.path).toBe("weak.md");
  expect(out.results[0]!.reasons.some((r) => r.startsWith("cross_encoder: "))).toBe(true);
});

test("enabled + unconfigured endpoint fails closed", async () => {
  const cfg = makeConfig({ vault, dbPath, rerank: { enabled: true } });
  await indexVault(cfg);
  await expect(search(cfg, { query: "fox", limit: 10 })).rejects.toBeInstanceOf(SearchError);
});

test("enabled + endpoint error degrades to heuristic order with a warning", async () => {
  const cfg = makeConfig({ vault, dbPath, rerank: ENABLED });
  await indexVault(cfg);
  globalThis.fetch = (async () =>
    new Response("upstream boom", { status: 503 })) as unknown as typeof fetch;
  const base = await search(makeConfig({ vault, dbPath }), { query: "fox", limit: 10 });
  const out = await search(cfg, { query: "fox", limit: 10 });
  expect(out.results.map((r) => r.path)).toEqual(base.results.map((r) => r.path));
  expect(out.warnings.some((w) => w.startsWith("rerank_degraded:"))).toBe(true);
});

// ─── the rerank liveness code on the retrieval trail ─────────────────────────

/** A 503 endpoint that counts the requests it answered. */
function failingRerankFetch(): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("upstream boom", { status: 503 });
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

test("a failed rerank names rerank-provider-unavailable with its category", async () => {
  const cfg = makeConfig({ vault, dbPath, rerank: ENABLED });
  await indexVault(cfg);
  const base = await search(makeConfig({ vault, dbPath }), { query: "fox", limit: 10 });
  failingRerankFetch();
  const out = await search(cfg, { query: "fox", limit: 10 });
  expect(out.results.map((r) => r.path)).toEqual(base.results.map((r) => r.path));
  // The human signal is byte-identical to v1.65.0.
  expect(out.warnings).toContain("rerank_degraded: rerank HTTP 503: upstream boom");
  expect(out.retrievalTrail?.degraded).toContainEqual({
    code: RETRIEVAL_DEGRADATION.rerankProviderUnavailable,
    detail: { category: "transient" },
  });
});

test("a failed rerank is served but never cached, so the next query retries", async () => {
  const cfg = makeConfig({ vault, dbPath, rerank: ENABLED, cacheEnabled: true });
  await indexVault(cfg);
  const endpoint = failingRerankFetch();
  await search(cfg, { query: "fox", limit: 10 });
  const second = await search(cfg, { query: "fox", limit: 10 });
  expect(endpoint.calls()).toBe(2);
  expect(second.retrievalTrail?.degraded.map((d) => d.code)).toContain(
    RETRIEVAL_DEGRADATION.rerankProviderUnavailable,
  );
});

test("a healthy rerank is cached as before", async () => {
  const cfg = makeConfig({ vault, dbPath, rerank: ENABLED, cacheEnabled: true });
  await indexVault(cfg);
  let calls = 0;
  stubRerankFetch("cats");
  const scoring = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    calls += 1;
    return scoring(...args);
  }) as unknown as typeof fetch;
  await search(cfg, { query: "fox", limit: 10 });
  await search(cfg, { query: "fox", limit: 10 });
  expect(calls).toBe(1);
});

test("a healthy rerank and a disabled rerank carry no trail", async () => {
  const enabled = makeConfig({ vault, dbPath, rerank: ENABLED });
  await indexVault(enabled);
  stubRerankFetch("cats");
  expect((await search(enabled, { query: "fox", limit: 10 })).retrievalTrail).toBeUndefined();
  const disabled = makeConfig({ vault, dbPath });
  expect((await search(disabled, { query: "fox", limit: 10 })).retrievalTrail).toBeUndefined();
});

test("a failed local reranker records the same code, unclassified and uncached", async () => {
  const cfg = makeConfig({
    vault,
    dbPath,
    rerank: { enabled: true, kind: "local", topK: 10 },
    cacheEnabled: true,
  });
  await indexVault(cfg);
  const failing = spyOn(LocalRerankProvider.prototype, "rerank").mockImplementation(() =>
    Promise.reject(new Error("model failed to load")),
  );
  try {
    await search(cfg, { query: "fox", limit: 10 });
    const second = await search(cfg, { query: "fox", limit: 10 });
    expect(failing).toHaveBeenCalledTimes(2);
    expect(second.retrievalTrail?.degraded).toContainEqual({
      code: RETRIEVAL_DEGRADATION.rerankProviderUnavailable,
      detail: { category: "unclassified" },
    });
  } finally {
    failing.mockRestore();
  }
  // The local reranker has no endpoint, so the sentence must not name one.
  expect(describeRetrievalDegradation(RETRIEVAL_DEGRADATION.rerankProviderUnavailable)).not.toMatch(
    /endpoint/u,
  );
});
