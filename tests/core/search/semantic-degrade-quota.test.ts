/**
 * Graceful semantic degrade on quota/rate-limit (Task C2). Implicit semantic
 * search (no explicit `--semantic`) degrades to keyword-only with a warning
 * that names the classification category and, for quota, the actionable
 * billing message. An explicit request keeps throwing the typed error and
 * never silently falls back.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { runSemanticPhase } from "../../../src/core/search/semantic-phase.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { Store } from "../../../src/core/search/store.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

let server: FakeHttp;

beforeEach(async () => {
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
});

/** Minimal Store stub: enough surface for runSemanticPhase to reach embed. */
function fakeStore(): Store {
  return {
    counts: () => ({ documents: 1, chunks: 1, embeddings: 1, staleEmbeddings: 0 }),
    vecLoaded: () => true,
    semanticTopK: () => [],
  } as unknown as Store;
}

function semanticConfig(overrides: Record<string, unknown> = {}) {
  return makeConfig({
    vault: "/tmp/does-not-matter",
    dbPath: "/tmp/does-not-matter/db.sqlite",
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "m",
      apiKey: "k",
      maxRetries: 1,
      ...overrides,
    },
  });
}

test("implicit semantic degrades with a quota warning carrying the actionable message", async () => {
  server.setHandler(() => ({ status: 402, body: { error: { message: "pay up" } } }));
  const out = await runSemanticPhase(fakeStore(), semanticConfig(), "q", {
    limit: 10,
    pathPrefix: undefined,
    explicit: false,
  });
  expect(out.attempted).toBe(false);
  expect(out.warnings.some((w) => w.includes("quota") && w.includes("billing"))).toBe(true);
});

test("implicit semantic degrade names the rate_limit category", async () => {
  server.setHandler(() => ({ status: 429, body: { error: "slow down" } }));
  const out = await runSemanticPhase(fakeStore(), semanticConfig(), "q", {
    limit: 10,
    pathPrefix: undefined,
    explicit: false,
  });
  expect(out.attempted).toBe(false);
  expect(out.warnings.some((w) => w.includes("rate_limit"))).toBe(true);
});

test("explicit semantic throws the typed quota error and never falls back", async () => {
  server.setHandler(() => ({ status: 402, body: { error: { message: "pay up" } } }));
  let err: SearchError | null = null;
  try {
    await runSemanticPhase(fakeStore(), semanticConfig(), "q", {
      limit: 10,
      pathPrefix: undefined,
      explicit: true,
    });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_QUOTA_EXHAUSTED");
});
