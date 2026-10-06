/**
 * What the spend gate's keyword-only answer must not turn into
 * (honest-query-embed-and-safe-upgrades, security audit round 1).
 *
 * The query-embed gateway refuses an unpriced embed for a caller that is
 * not local and serves the keyword lane instead, disclosed on the trail.
 * That answer is honest for the one request that received it. It is not
 * honest as a cached answer the operator's later price declaration cannot
 * reach, as a learned-weights signal, or as a benchmark score a tuning
 * sweep saves as the vault's parameters.
 *
 * Every refused embed is counted on a loopback stub: the gated runs below
 * reach nothing on the wire.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import {
  parseRecallBenchmarkDataset,
  runRecallBenchmark,
} from "../../../src/core/search/benchmark.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import { search } from "../../../src/core/search/search.ts";
import { tuneRecall } from "../../../src/core/search/tuning.ts";
import { tuningPath } from "../../../src/core/search/tuning-store.ts";
import { SearchError, type ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

const MODEL = "fake-model";
const GATE_USD = 1;
const NOTE = "# Fox\n\nThe quick brown fox jumps over the lazy dog.";
const NOW = new Date("2026-10-06T12:00:00Z");

let server: FakeHttp;
let cleanup: () => void = () => {};

beforeEach(async () => {
  server = await startFakeHttp();
  server.setHandler((req) => {
    const body = (req.body ?? {}) as { input?: string[] };
    const batch = Array.isArray(body.input) ? body.input : [];
    return {
      status: 200,
      body: {
        data: batch.map((text, index) => ({
          object: "embedding",
          embedding: [text.length, index, 1, 1],
          index,
        })),
        model: MODEL,
      },
    };
  });
});

afterEach(async () => {
  cleanup();
  cleanup = () => {};
  await server.close();
});

/**
 * An index built with embeddings (no gate while indexing), then served
 * under a positive gate on an unpriced model with the query cache on.
 */
async function gatedIndex(): Promise<ResolvedSearchConfig> {
  const v = createTempVault("spend-gate-disclosure");
  cleanup = v.cleanup;
  writeMd(v.vault, "Notes/fox.md", NOTE);
  const config = makeConfig({
    vault: v.vault,
    dbPath: v.dbPath,
    cacheEnabled: true,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      maxRetries: 1,
      costGateUsd: 0,
    },
  });
  await indexVault(config, { embeddings: true });
  return { ...config, semantic: { ...config.semantic, costGateUsd: GATE_USD } };
}

function priced(config: ResolvedSearchConfig): ResolvedSearchConfig {
  return {
    ...config,
    semantic: { ...config.semantic, priceOverride: { model: MODEL, usdPerMtok: 0 } },
  };
}

function queryCacheRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ c: number }, []>("SELECT count(*) AS c FROM query_cache").get()?.c ?? 0;
  } finally {
    db.close();
  }
}

const DATASET = parseRecallBenchmarkDataset({
  queries: [{ id: "fox", query: "fox", expected: ["Notes/fox.md"] }],
});

// ── the query cache ──────────────────────────────────────────────────────────

test("a gated keyword-only answer is served but never cached", async () => {
  if (!sqliteVecLoadable()) return;
  const config = await gatedIndex();
  const out = await search(config, { query: "fox", limit: 5 });
  expect(out.retrievalTrail?.degraded.map((d) => d.code)).toContain(
    RETRIEVAL_DEGRADATION.semanticCostUnpriced,
  );
  expect(out.results.length).toBeGreaterThan(0);
  expect(queryCacheRows(config.dbPath)).toBe(0);
});

test("a price declared after a gated answer reaches the next remote query", async () => {
  if (!sqliteVecLoadable()) return;
  const config = await gatedIndex();
  await search(config, { query: "fox", limit: 5 });
  const before = server.callCount();
  const out = await search(priced(config), { query: "fox", limit: 5 });
  expect(server.callCount()).toBe(before + 1);
  expect(out.retrievalTrail?.degraded.map((d) => d.code) ?? []).not.toContain(
    RETRIEVAL_DEGRADATION.semanticCostUnpriced,
  );
});

test("an ungated local answer is still cached", async () => {
  if (!sqliteVecLoadable()) return;
  const config = await gatedIndex();
  await search(config, { query: "fox", limit: 5, transportReach: TRANSPORT_REACH.local });
  expect(queryCacheRows(config.dbPath)).toBe(1);
});

function windowed(config: ResolvedSearchConfig, inputWindowTokens: number): ResolvedSearchConfig {
  return { ...config, semantic: { ...config.semantic, inputWindowTokens } };
}

const LONG_QUERY = Array.from({ length: 40 }, () => "fox").join(" ");

test("a query cut to its window is served but never cached", async () => {
  if (!sqliteVecLoadable()) return;
  const config = windowed(await gatedIndex(), 4);
  const local = { query: LONG_QUERY, limit: 5, transportReach: TRANSPORT_REACH.local };
  const cut = await search(config, local);
  expect(cut.retrievalTrail?.degraded.map((d) => d.code)).toContain(
    RETRIEVAL_DEGRADATION.semanticQueryTruncated,
  );
  expect(queryCacheRows(config.dbPath)).toBe(0);
  // A wider window declared afterwards reaches the next identical query.
  const before = server.callCount();
  const whole = await search(windowed(config, 8192), local);
  expect(server.callCount()).toBe(before + 1);
  expect(whole.retrievalTrail?.degraded.map((d) => d.code) ?? []).not.toContain(
    RETRIEVAL_DEGRADATION.semanticQueryTruncated,
  );
});

// ── the benchmark ────────────────────────────────────────────────────────────

test("a gated benchmark discloses the degradation per query and in aggregate", async () => {
  if (!sqliteVecLoadable()) return;
  const config = await gatedIndex();
  const report = await runRecallBenchmark(config, DATASET, {
    transportReach: TRANSPORT_REACH.remote,
  });
  expect(report.degraded).toContain(RETRIEVAL_DEGRADATION.semanticCostUnpriced);
  expect(report.degraded).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
  expect(report.perQuery[0]?.degraded).toContain(RETRIEVAL_DEGRADATION.semanticCostUnpriced);
});

test("an ungated benchmark reports no degradation and adds no per-query field", async () => {
  if (!sqliteVecLoadable()) return;
  const config = await gatedIndex();
  const report = await runRecallBenchmark(config, DATASET, {
    transportReach: TRANSPORT_REACH.local,
  });
  expect(report.degraded).toEqual([]);
  expect(report.perQuery[0]).not.toHaveProperty("degraded");
});

// ── the tuning sweep ─────────────────────────────────────────────────────────

const GRID = [{ poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: false }];

test("a tuning sweep measured with a gated lane refuses to save its winner", async () => {
  if (!sqliteVecLoadable()) return;
  const config = await gatedIndex();
  let err: unknown = null;
  try {
    await tuneRecall(config, DATASET, {
      grid: GRID,
      now: NOW,
      transportReach: TRANSPORT_REACH.remote,
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SearchError);
  expect((err as SearchError).code).toBe("EMBEDDING_COST_UNPRICED");
  expect((err as SearchError).message).toContain("embedding_cost_gate_usd");
  expect(existsSync(tuningPath(config.vault))).toBe(false);
});

test("a tuning sweep measured with the provider unreachable refuses to save its winner", async () => {
  if (!sqliteVecLoadable()) return;
  const config = await gatedIndex();
  server.setHandler(() => ({ status: 500, body: { error: { message: "down" } } }));
  let err: unknown = null;
  try {
    await tuneRecall(config, DATASET, {
      grid: GRID,
      now: NOW,
      transportReach: TRANSPORT_REACH.local,
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SearchError);
  expect((err as SearchError).code).toBe("EMBEDDING_PROVIDER_HTTP");
  expect((err as SearchError).message).toContain(RETRIEVAL_DEGRADATION.semanticProviderUnavailable);
  expect(existsSync(tuningPath(config.vault))).toBe(false);
});

test("an ungated tuning sweep saves its winner and reports no degradation", async () => {
  if (!sqliteVecLoadable()) return;
  const config = await gatedIndex();
  const report = await tuneRecall(config, DATASET, {
    grid: GRID,
    now: NOW,
    transportReach: TRANSPORT_REACH.local,
  });
  expect(report.degraded).toEqual([]);
  expect(report.evaluated[0]?.degraded).toEqual([]);
  expect(existsSync(tuningPath(config.vault))).toBe(true);
});
