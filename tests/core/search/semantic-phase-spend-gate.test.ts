/**
 * The search lane's query embed goes through the query-embed gateway
 * (honest-query-embed-and-safe-upgrades, task 4).
 *
 * Before this, `runSemanticPhase` embedded every query with no reach and
 * no price check, so a remote caller of `brain_search` (and every tool
 * that reaches the lane) spent the operator's money on a model nobody
 * priced, despite a positive `embedding_cost_gate_usd`. The query was
 * also sent at any length, so a model with a small window either
 * described a prefix silently or refused the request.
 *
 * Every assertion counts requests on a loopback stub: "refused" means
 * nothing reached the wire, not that a response was ignored.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { COST_GATE_KEY, formatEstimatedUsd } from "../../../src/core/search/embedding-spend.ts";
import {
  fitQueryToWindow,
  prepareQueryEmbed,
  queryEmbedCutMessage,
  queryEmbedEmptyFitMessage,
} from "../../../src/core/search/embeddings/query-embed.ts";
import { INPUT_WINDOW_TOKENS_KEY } from "../../../src/core/search/embeddings/presets.ts";
import {
  EMBEDDING_PRICE_MODEL_KEY,
  EMBEDDING_PRICE_RATE_KEY,
} from "../../../src/core/search/embeddings/pricing.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { runSemanticLane } from "../../../src/core/search/pipeline/semantic-lane.ts";
import {
  RETRIEVAL_DEGRADATION,
  describeRetrievalDegradation,
  RETRIEVAL_DEGRADATION_CODES,
  semanticLaneMissing,
} from "../../../src/core/search/retrieval-trail.ts";
import { search } from "../../../src/core/search/search.ts";
import { runSemanticPhase } from "../../../src/core/search/semantic-phase.ts";
import type { Store } from "../../../src/core/search/store.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../src/mcp/index.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

const MODEL = "fake-model";
const GATE_USD = 1;

let server: FakeHttp;
let inputs: string[][];

beforeEach(async () => {
  server = await startFakeHttp();
  inputs = [];
  server.setHandler((req) => {
    const body = (req.body ?? {}) as { input?: string[] };
    const batch = Array.isArray(body.input) ? body.input : [];
    inputs.push(batch);
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
  await server.close();
});

/** Enough surface for the phase and the lane to reach the embed. */
function fakeStore(): Store {
  return {
    counts: () => ({ documents: 1, chunks: 1, embeddings: 1, staleEmbeddings: 0 }),
    vecLoaded: () => true,
    semanticTopK: () => [],
    embeddingAbiMismatches: () => [],
  } as unknown as Store;
}

function gatedConfig(semantic: Record<string, unknown> = {}) {
  return makeConfig({
    vault: "/tmp/does-not-matter",
    dbPath: "/tmp/does-not-matter/db.sqlite",
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      maxRetries: 1,
      costGateUsd: GATE_USD,
      ...semantic,
    },
  });
}

function phaseOpts(explicit: boolean, reach?: "local" | "remote") {
  return {
    limit: 10,
    pathPrefix: undefined,
    explicit,
    ...(reach !== undefined ? { transportReach: TRANSPORT_REACH[reach] } : {}),
  };
}

function codes(degraded: ReadonlyArray<{ code: string }>): string[] {
  return degraded.map((d) => d.code);
}

// ── the vocabulary ───────────────────────────────────────────────────────────

test("the three new codes are members of the closed list and carry a sentence", () => {
  for (const code of [
    RETRIEVAL_DEGRADATION.semanticCostUnpriced,
    RETRIEVAL_DEGRADATION.semanticQueryTruncated,
    RETRIEVAL_DEGRADATION.semanticQueryEmptyFit,
  ]) {
    expect(RETRIEVAL_DEGRADATION_CODES).toContain(code);
    expect(describeRetrievalDegradation(code).length).toBeGreaterThan(0);
  }
  expect(RETRIEVAL_DEGRADATION.semanticCostUnpriced).toBe("semantic-cost-unpriced");
  expect(RETRIEVAL_DEGRADATION.semanticQueryTruncated).toBe("semantic-query-truncated");
  expect(RETRIEVAL_DEGRADATION.semanticQueryEmptyFit).toBe("semantic-query-empty-fit");
});

// ── the phase ────────────────────────────────────────────────────────────────

test("an implicit remote query under a positive gate and an unpriced model sends nothing", async () => {
  const out = await runSemanticPhase(fakeStore(), gatedConfig(), "q", phaseOpts(false, "remote"));
  expect(server.callCount()).toBe(0);
  expect(out.attempted).toBe(false);
  expect(codes(out.degraded)).toEqual([RETRIEVAL_DEGRADATION.semanticCostUnpriced]);
  expect(out.warnings).toHaveLength(1);
  for (const part of [MODEL, COST_GATE_KEY, EMBEDDING_PRICE_MODEL_KEY, EMBEDDING_PRICE_RATE_KEY]) {
    expect(out.warnings[0]).toContain(part);
  }
  expect(out.warnings.some((w) => w.includes(formatEstimatedUsd(GATE_USD)))).toBe(false);
});

test("an omitted reach is remote, so the gate refuses it too", async () => {
  const out = await runSemanticPhase(fakeStore(), gatedConfig(), "q", phaseOpts(false));
  expect(server.callCount()).toBe(0);
  expect(codes(out.degraded)).toEqual([RETRIEVAL_DEGRADATION.semanticCostUnpriced]);
});

test("an explicit remote query throws EMBEDDING_COST_UNPRICED naming the levers", async () => {
  let err: unknown = null;
  try {
    await runSemanticPhase(fakeStore(), gatedConfig(), "q", phaseOpts(true, "remote"));
  } catch (e) {
    err = e;
  }
  expect(server.callCount()).toBe(0);
  expect(err).toBeInstanceOf(SearchError);
  const e = err as SearchError;
  expect(e.code).toBe("EMBEDDING_COST_UNPRICED");
  for (const part of [MODEL, COST_GATE_KEY, EMBEDDING_PRICE_MODEL_KEY, EMBEDDING_PRICE_RATE_KEY]) {
    expect(e.message).toContain(part);
  }
  // The operator's budget is not the remote caller's business.
  expect(e.message).not.toContain(formatEstimatedUsd(GATE_USD));
});

test("a local query under the same gate embeds once", async () => {
  const out = await runSemanticPhase(fakeStore(), gatedConfig(), "q", phaseOpts(true, "local"));
  expect(server.callCount()).toBe(1);
  expect(out.attempted).toBe(true);
  expect(out.degraded).toEqual([]);
});

test("a remote query on an operator-priced model embeds once", async () => {
  const config = gatedConfig({ priceOverride: { model: MODEL, usdPerMtok: 0 } });
  const out = await runSemanticPhase(fakeStore(), config, "q", phaseOpts(true, "remote"));
  expect(server.callCount()).toBe(1);
  expect(out.attempted).toBe(true);
});

test("an over-window query embeds the cut text and names the window", async () => {
  const window = 8;
  const query = "abcdefghij".repeat(20);
  const config = gatedConfig({ costGateUsd: 0, inputWindowTokens: window });
  const out = await runSemanticPhase(fakeStore(), config, query, phaseOpts(false, "remote"));
  expect(server.callCount()).toBe(1);
  const expected = fitQueryToWindow(query, "", window).text;
  expect(expected.length).toBeLessThan(query.length);
  expect(inputs).toEqual([[expected]]);
  expect(out.attempted).toBe(true);
  expect(out.degraded).toEqual([
    { code: RETRIEVAL_DEGRADATION.semanticQueryTruncated, detail: { windowTokens: window } },
  ]);
  const prepared = prepareQueryEmbed(config, query, TRANSPORT_REACH.remote);
  if (prepared.kind !== "ready" || !prepared.truncated) throw new Error("narrowed wrong");
  expect(out.warnings).toEqual([queryEmbedCutMessage(prepared, query)]);
  expect(out.warnings[0]).toContain(INPUT_WINDOW_TOKENS_KEY);
});

test("a query that fits the window is sent whole with no warning", async () => {
  const config = gatedConfig({ costGateUsd: 0, inputWindowTokens: 512 });
  const out = await runSemanticPhase(fakeStore(), config, "short", phaseOpts(false, "remote"));
  expect(inputs).toEqual([["short"]]);
  expect(out.warnings).toEqual([]);
  expect(out.degraded).toEqual([]);
});

test("a prefix that fills the window is never embedded", async () => {
  const config = gatedConfig({
    costGateUsd: 0,
    inputWindowTokens: 1,
    queryPrefix: "a long instruction prefix: ",
  });
  const out = await runSemanticPhase(fakeStore(), config, "q", phaseOpts(false, "remote"));
  expect(server.callCount()).toBe(0);
  expect(out.attempted).toBe(false);
  // Its own code, not the cut's: the lane did not run, so it counts as a stop.
  expect(out.degraded).toEqual([
    { code: RETRIEVAL_DEGRADATION.semanticQueryEmptyFit, detail: { windowTokens: 1 } },
  ]);
  const prepared = prepareQueryEmbed(config, "q", TRANSPORT_REACH.remote);
  if (prepared.kind !== "ready" || !prepared.truncated) throw new Error("narrowed wrong");
  expect(out.warnings).toEqual([queryEmbedEmptyFitMessage(prepared)]);

  let err: unknown = null;
  try {
    await runSemanticPhase(fakeStore(), config, "q", phaseOpts(true, "remote"));
  } catch (e) {
    err = e;
  }
  expect(server.callCount()).toBe(0);
  expect((err as SearchError).code).toBe("INVALID_INPUT");
  expect((err as SearchError).message).toBe(queryEmbedEmptyFitMessage(prepared));
});

// ── the lane ─────────────────────────────────────────────────────────────────

function laneInput(config: ReturnType<typeof gatedConfig>, query: string, reach?: "local") {
  return {
    store: fakeStore(),
    config,
    policy: { explicit: false, wantSemantic: true },
    query,
    semanticLaneQuery: null,
    limit: 10,
    pathPrefix: undefined,
    keywordHitCount: 1,
    ...(reach !== undefined ? { transportReach: TRANSPORT_REACH[reach] } : {}),
  };
}

test("the lane forwards reach: a refused remote lane degrades the hybrid answer", async () => {
  const out = await runSemanticLane(laneInput(gatedConfig(), "q"));
  expect(server.callCount()).toBe(0);
  expect(codes(out.degraded)).toEqual([
    RETRIEVAL_DEGRADATION.semanticCostUnpriced,
    RETRIEVAL_DEGRADATION.hybridDegraded,
  ]);
});

test("the lane forwards reach: a local lane embeds", async () => {
  const out = await runSemanticLane(laneInput(gatedConfig(), "q", "local"));
  expect(server.callCount()).toBe(1);
  expect(out.attempted).toBe(true);
});

test("a cut lane still ran, so the hybrid answer is not degraded", async () => {
  const config = gatedConfig({ costGateUsd: 0, inputWindowTokens: 8 });
  const out = await runSemanticLane(laneInput(config, "abcdefghij".repeat(20)));
  expect(codes(out.degraded)).toEqual([RETRIEVAL_DEGRADATION.semanticQueryTruncated]);
});

test("an empty-fit lane with no keyword hit still reads as a stopped lane", async () => {
  const config = gatedConfig({
    costGateUsd: 0,
    inputWindowTokens: 1,
    queryPrefix: "a long instruction prefix: ",
  });
  const out = await runSemanticLane({ ...laneInput(config, "q"), keywordHitCount: 0 });
  expect(server.callCount()).toBe(0);
  expect(codes(out.degraded)).toEqual([RETRIEVAL_DEGRADATION.semanticQueryEmptyFit]);
  expect(semanticLaneMissing(out.degraded.map((d) => d.code))).toBe(true);
});

// ── search() over a real index ───────────────────────────────────────────────

const NOTE = "# Fox\n\nThe quick brown fox jumps over the lazy dog.";

async function indexedSearchConfig(costGateUsd: number) {
  const v = createTempVault("spend-gate");
  writeMd(v.vault, "Notes/fox.md", NOTE);
  const config = gatedConfig({ costGateUsd: 0 });
  const indexed = { ...config, vault: v.vault, dbPath: v.dbPath };
  await indexVault(indexed, { embeddings: true });
  return {
    config: { ...indexed, semantic: { ...indexed.semantic, costGateUsd } },
    cleanup: v.cleanup,
  };
}

test.skipIf(!sqliteVecLoadable())(
  "search() threads reach: remote implicit serves keyword results without an embed",
  async () => {
    const { config, cleanup } = await indexedSearchConfig(GATE_USD);
    try {
      const before = server.callCount();
      const out = await search(config, { query: "fox", limit: 5 });
      expect(server.callCount()).toBe(before);
      expect(out.results.length).toBeGreaterThan(0);
      const trail = codes(out.retrievalTrail?.degraded ?? []);
      expect(trail).toContain(RETRIEVAL_DEGRADATION.semanticCostUnpriced);
      expect(trail).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
    } finally {
      cleanup();
    }
  },
);

test.skipIf(!sqliteVecLoadable())(
  "search() threads reach: remote explicit throws before the embed",
  async () => {
    const { config, cleanup } = await indexedSearchConfig(GATE_USD);
    try {
      const before = server.callCount();
      let err: unknown = null;
      try {
        await search(config, { query: "fox", limit: 5, semantic: true });
      } catch (e) {
        err = e;
      }
      expect(server.callCount()).toBe(before);
      expect((err as SearchError).code).toBe("EMBEDDING_COST_UNPRICED");
    } finally {
      cleanup();
    }
  },
);

test.skipIf(!sqliteVecLoadable())(
  "search() threads reach: a local search embeds once",
  async () => {
    const { config, cleanup } = await indexedSearchConfig(GATE_USD);
    try {
      const before = server.callCount();
      await search(config, {
        query: "fox",
        limit: 5,
        semantic: true,
        transportReach: TRANSPORT_REACH.local,
      });
      expect(server.callCount()).toBe(before + 1);
    } finally {
      cleanup();
    }
  },
);

// ── brain_search over MCP ────────────────────────────────────────────────────

let tmp: string;
let configPath: string;

async function mcpVault(): Promise<string> {
  tmp = mkdtempSync(join(tmpdir(), "o2b-spend-gate-"));
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, "Notes", "fox.md"), NOTE);
  configPath = join(tmp, "config.yaml");
  const lines = (gate: number) =>
    [
      `vault: ${vault}`,
      "agent_name: claude",
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: ${server.url}`,
      `embedding_model: ${MODEL}`,
      `embedding_api_key: ${FAKE_PROVIDER_KEY}`,
      "embedding_dimension: 4",
      `${COST_GATE_KEY}: ${gate}`,
      "",
    ].join("\n");
  atomicWriteFileSync(configPath, lines(0));
  await indexVault(resolveSearchConfig({ vault, configPath }), { embeddings: true });
  atomicWriteFileSync(configPath, lines(GATE_USD));
  return vault;
}

async function mcpSearch(vault: string, reach: "local" | "remote", semantic: boolean) {
  const mcp = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH[reach] });
  await mcp.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "spend-gate-test", version: "0" },
    },
  });
  await mcp.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return (await mcp.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: "brain_search", arguments: { query: "fox", limit: 5, semantic } },
  })) as { error?: { data?: { code?: string } } };
}

test.skipIf(!sqliteVecLoadable())(
  "brain_search over a remote server refuses before the embed; a local one embeds",
  async () => {
    const vault = await mcpVault();
    const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    try {
      const before = server.callCount();
      const remote = await mcpSearch(vault, "remote", true);
      expect(server.callCount()).toBe(before);
      expect(remote.error?.data?.code).toBe("EMBEDDING_COST_UNPRICED");

      const local = await mcpSearch(vault, "local", true);
      expect(local.error).toBeUndefined();
      expect(server.callCount()).toBe(before + 1);
    } finally {
      if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
