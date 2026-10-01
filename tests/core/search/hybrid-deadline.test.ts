/**
 * Composite hybrid deadline (t_bdc24171). One wall-clock budget spans the
 * whole composite path (embed -> semanticTopK -> rerank -> second pass);
 * when it fires the search completes keyword-only and names it with the
 * closed-vocabulary `hybridDeadlineExceeded` degradation - never a stall,
 * never a silent partial. The per-lane budgets (10s embed, 5s rerank) keep
 * their own earlier timeouts; the deadline bounds the phases with no budget
 * of their own and pathological sums.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { search } from "../../../src/core/search/search.ts";
import {
  DEFAULT_HYBRID_DEADLINE_MS,
  resolveSearchRequest,
} from "../../../src/core/search/pipeline/request.ts";
import {
  RETRIEVAL_DEGRADATION,
  describeRetrievalDegradation,
  isRetrievalDegradationCode,
} from "../../../src/core/search/retrieval-trail.ts";
import { DEFAULT_RERANK_TIMEOUT_MS } from "../../../src/core/search/rerank/cross-encoder.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { parseStructuredRecallQueryDocument } from "../../../src/core/search/structured-query.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp, type FakeResponseSpec } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

const ENV_KEYS = ["OPEN_SECOND_BRAIN_SEARCH_HYBRID_DEADLINE"];
let origEnv: Record<string, string | undefined>;

// The two stall tests hold real sockets open while the deadline races
// them; under the full-suite load the temp-vault and server setup can
// outlast bun's 5s default hook timeout, so both hooks carry an
// explicit one.
beforeEach(async () => {
  const v = createTempVault("hybrid-deadline");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
  origEnv = {};
  for (const k of ENV_KEYS) {
    origEnv[k] = process.env[k];
    delete process.env[k];
  }
}, 20_000);

afterEach(async () => {
  cleanup();
  await server.close();
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
}, 20_000);

function semanticConfig() {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "fake-model",
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      timeoutMs: 5_000,
      concurrency: 2,
      batchSize: 8,
      costGateUsd: 0,
      maxRetries: 1,
    },
  });
}

async function seedCorpus() {
  writeMd(vault, "Notes/fox.md", "# Fox\n\nThe quick brown fox jumps over the lazy dog.");
  writeMd(vault, "Other/bar.md", "# Bar\n\nA different note about cats and turtles.");
}

/** A handler that never answers: the stalled-lane case the deadline exists
 * for. The fake-http closer settles in-flight handlers at teardown, so the
 * never-answer shape costs the suite nothing under either Bun toolchain. */
function stallHandler() {
  return () => new Promise<FakeResponseSpec>(() => {});
}

type SearchRun = Awaited<ReturnType<typeof search>>;

/**
 * The stable projection of a run's rows: which paths, in which order,
 * typed and explained the same way. The recency layer's wall-clock decay
 * between two runs is the one float that legitimately differs, so the
 * identity assertions ride this instead of raw result bytes.
 */
function resultShape(out: SearchRun): ReadonlyArray<unknown> {
  return out.results.map((r) => [r.path, r.searchType, r.score > 0, r.reasons]);
}

function configWithDeadline(deadlineMs: number): ReturnType<typeof semanticConfig> {
  return { ...semanticConfig(), hybridDeadlineMs: deadlineMs };
}

test("the resolved deadline defaults to the sum of the two named lane budgets", () => {
  const cfg = resolveSearchConfig({ vault });
  expect(DEFAULT_HYBRID_DEADLINE_MS).toBe(15_000);
  expect(cfg.hybridDeadlineMs).toBe(cfg.semantic.timeoutMs + DEFAULT_RERANK_TIMEOUT_MS);
  expect(cfg.hybridDeadlineMs).toBe(15_000);
});

test("a hand-built config without the field runs with no deadline, not with the default", () => {
  // The default is the CONFIG resolver's doing; a config constructed
  // literally opts out by omission, which is what keeps the plain keyword
  // path clock-clean for the rank-clock census. Pinned here so the request
  // resolver never quietly starts applying the default to fixtures.
  const request = resolveSearchRequest(semanticConfig(), { query: "fox", limit: 5 });
  expect(request.hybridDeadlineMs).toBeNull();
  expect(
    resolveSearchRequest(configWithDeadline(DEFAULT_HYBRID_DEADLINE_MS), {
      query: "fox",
      limit: 5,
    }).hybridDeadlineMs,
  ).toBe(DEFAULT_HYBRID_DEADLINE_MS);
  expect(
    resolveSearchRequest(configWithDeadline(0), { query: "fox", limit: 5 }).hybridDeadlineMs,
  ).toBeNull();
});

test("the env variable resolves the deadline over the default", () => {
  process.env.OPEN_SECOND_BRAIN_SEARCH_HYBRID_DEADLINE = "20000";
  expect(resolveSearchConfig({ vault }).hybridDeadlineMs).toBe(20_000);
});

test("the yaml config key resolves the deadline", () => {
  const tmp = mkdtempSync(join(tmpdir(), "osb-hybrid-deadline-cfg-"));
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${tmp}\nsearch_hybrid_deadline_ms: 12000\n`);
  try {
    expect(resolveSearchConfig({ vault: tmp, configPath }).hybridDeadlineMs).toBe(12_000);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("an invalid deadline is refused by name; 0 is accepted and means off", () => {
  expect(() => resolveSearchConfig({ vault, overrides: { hybridDeadlineMs: -1 } })).toThrow(
    SearchError,
  );
  expect(() => resolveSearchConfig({ vault, overrides: { hybridDeadlineMs: 1.5 } })).toThrow(
    SearchError,
  );
  expect(resolveSearchConfig({ vault, overrides: { hybridDeadlineMs: 0 } }).hybridDeadlineMs).toBe(
    0,
  );
  process.env.OPEN_SECOND_BRAIN_SEARCH_HYBRID_DEADLINE = "abc";
  expect(() => resolveSearchConfig({ vault })).toThrow(/search_hybrid_deadline_ms/);
});

test("a stalled semantic lane past the budget yields keyword-only results and names the deadline", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  const cfg = configWithDeadline(300);
  await indexVault(cfg, { embeddings: true });

  server.setHandler(stallHandler());
  const started = Date.now();
  const out = await search(cfg, { query: "fox", limit: 5, semantic: true });
  const wallMs = Date.now() - started;

  // Never a stall: the answer comes back around the budget, not around the
  // stalled lane's own timeout.
  expect(wallMs).toBeLessThan(3_000);
  expect(out.results.length).toBeGreaterThan(0);
  expect(out.results.every((r) => r.path.includes("fox"))).toBe(true);

  const codes = out.retrievalTrail?.degraded.map((d) => d.code) ?? [];
  expect(codes).toContain(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded);
  expect(codes).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
  const deadlineEntry = out.retrievalTrail?.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.hybridDeadlineExceeded,
  );
  expect(deadlineEntry?.detail).toEqual({ elapsedMs: expect.any(Number), budgetMs: 300 });
  expect(deadlineEntry?.detail?.elapsedMs).toBeGreaterThanOrEqual(300);
  expect(out.warnings.some((w) => w.includes("hybrid deadline"))).toBe(true);
});

test("the deadline degrade is keyword-only byte-shaped like the provider-unavailable degrade", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  const cfg = configWithDeadline(300);
  await indexVault(cfg, { embeddings: true });

  // The provider-unavailable baseline: the implicit lane refuses fast and
  // degrades (the explicit arm keeps its typed throw - untouched here).
  server.setHandler(() => ({ status: 402, body: { error: { message: "pay up" } } }));
  const quotaOut = await search({ ...cfg, hybridDeadlineMs: 0 }, { query: "fox", limit: 5 });

  // The deadline path with the lane stalled past the budget.
  server.setHandler(stallHandler());
  const deadlineOut = await search(cfg, { query: "fox", limit: 5 });

  // Same rows, same order, same typing - the recency layer's wall-clock
  // decay between the two runs is the only float that differs.
  expect(resultShape(deadlineOut)).toEqual(resultShape(quotaOut));
  expect(deadlineOut.results.map((r) => r.searchType)).toEqual(["keyword"]);
  const quotaCodes = quotaOut.retrievalTrail?.degraded.map((d) => d.code) ?? [];
  const deadlineCodes = deadlineOut.retrievalTrail?.degraded.map((d) => d.code) ?? [];
  expect(quotaCodes).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
  expect(deadlineCodes).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
  expect(deadlineCodes).toContain(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded);
});

test("deadline 0 (off) and the default keep normal-path results identical", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  await indexVault(semanticConfig(), { embeddings: true });

  // The recency layer decays with wall-clock time between runs, so the
  // identity assertion rides the stable projection: which rows, in which
  // order, typed and explained the same way.
  const unset = resultShape(
    await search(semanticConfig(), { query: "fox", limit: 5, semantic: true }),
  );
  expect(
    resultShape(
      await search(configWithDeadline(DEFAULT_HYBRID_DEADLINE_MS), {
        query: "fox",
        limit: 5,
        semantic: true,
      }),
    ),
  ).toEqual(unset);
  expect(
    resultShape(await search(configWithDeadline(0), { query: "fox", limit: 5, semantic: true })),
  ).toEqual(unset);
  const codes =
    (
      await search(configWithDeadline(DEFAULT_HYBRID_DEADLINE_MS), {
        query: "fox",
        limit: 5,
        semantic: true,
      })
    ).retrievalTrail?.degraded.map((d) => d.code) ?? [];
  expect(codes).not.toContain(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded);
});

test("the deadline bounds the composite path with rerank enabled and every lane stalled", async () => {
  if (!sqliteVecLoadable()) return;
  await seedCorpus();
  const base = semanticConfig();
  const cfg = {
    ...base,
    hybridDeadlineMs: 300,
    rerank: {
      ...base.rerank,
      enabled: true,
      baseUrl: server.url,
      model: "rerank-fake",
      apiKey: FAKE_PROVIDER_KEY,
    },
  };
  await indexVault(cfg, { embeddings: true });

  server.setHandler(stallHandler());
  const started = Date.now();
  const out = await search(cfg, { query: "fox", limit: 5, semantic: true });
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(out.results.length).toBeGreaterThan(0);
  const codes = out.retrievalTrail?.degraded.map((d) => d.code) ?? [];
  expect(codes).toContain(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded);
});

test("the new code rides the closed vocabulary and its sentence names the deadline", () => {
  // Sentence UNIQUENESS across the whole vocabulary is owned by
  // retrieval-trail.test.ts; this test owns this code's value and sentence.
  expect(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded).toBe("hybrid-deadline-exceeded");
  expect(isRetrievalDegradationCode("hybrid-deadline-exceeded")).toBe(true);
  const sentence = describeRetrievalDegradation(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded);
  expect(sentence.toLowerCase()).toContain("deadline");
});

/** Keyword-only config, trust gate on, remote rerank at `rerankBaseUrl`. */
function stalledRerankConfig(opts: { cacheEnabled?: boolean; rerankBaseUrl?: string } = {}) {
  return {
    ...makeConfig({
      vault,
      dbPath,
      retrievalTrustGateEnabled: true,
      cacheEnabled: opts.cacheEnabled ?? false,
      rerank: {
        enabled: true,
        kind: "openai-compat",
        baseUrl: opts.rerankBaseUrl ?? server.url,
        model: "rerank-fake",
        apiKey: FAKE_PROVIDER_KEY,
      },
    }),
    hybridDeadlineMs: 300,
  };
}

function seedGatedCorpus(): void {
  writeMd(vault, "clean.md", "# Clean\n\nThe widget calibration routine runs every morning.");
  writeMd(
    vault,
    "quarantined.md",
    "---\nstatus: quarantine\n---\n\n# Bad\n\nThe widget calibration is unsafe.",
  );
  writeMd(vault, "draft.md", "# Draft\n\nA draft of the widget calibration routine.");
}

test("a stalled rerank past the deadline still applies exclusions and the trust gate", async () => {
  seedGatedCorpus();
  const cfg = stalledRerankConfig();
  await indexVault(cfg);
  server.setHandler(stallHandler());

  const out = await search(cfg, {
    query: "widget calibration",
    structuredQuery: parseStructuredRecallQueryDocument('lex: "widget calibration" -draft'),
    limit: 5,
  });

  const paths = out.results.map((r) => r.path);
  expect(paths).toEqual(["clean.md"]);
  // The gate ran on the degraded order, so its receipt is on the outcome.
  expect(out.retrievalDecisionTrace).toBeDefined();
  const codes = out.retrievalTrail?.degraded.map((d) => d.code) ?? [];
  expect(codes).toContain(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded);
});

test("the deadline aborts the abandoned rerank request instead of leaving it running", async () => {
  seedGatedCorpus();
  const { promise: requestAborted, resolve: aborted } = Promise.withResolvers<void>();
  // A local server that watches the client side of the stalled request:
  // the abort reaches it only if the deadline cancels the fetch.
  const watcher = Bun.serve({
    port: 0,
    fetch: (req) => {
      req.signal.addEventListener("abort", () => aborted(), { once: true });
      return new Promise<Response>(() => {});
    },
  });
  try {
    const cfg = stalledRerankConfig({ rerankBaseUrl: `http://127.0.0.1:${watcher.port}/v1` });
    await indexVault(cfg);
    await search(cfg, { query: "widget calibration", limit: 5 });
    const outcome = await Promise.race([
      requestAborted.then(() => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 2_000)),
    ]);
    expect(outcome).toBe("aborted");
  } finally {
    watcher.stop(true);
  }
});

test("a deadline-degraded answer is never written to the query cache", async () => {
  seedGatedCorpus();
  const cfg = stalledRerankConfig({ cacheEnabled: true });
  await indexVault(cfg);

  server.setHandler(stallHandler());
  const degraded = await search(cfg, { query: "widget calibration", limit: 5 });
  expect(degraded.retrievalTrail?.degraded.map((d) => d.code)).toContain(
    RETRIEVAL_DEGRADATION.hybridDeadlineExceeded,
  );

  // A fast endpoint now: a cached degraded answer would still name the
  // deadline; a fresh compute does not.
  server.setHandler((req) => {
    const docs = ((req.body ?? {}) as { documents?: string[] }).documents ?? [];
    return {
      status: 200,
      body: { results: docs.map((_, index) => ({ index, relevance_score: 1 - index / 10 })) },
    };
  });
  const fresh = await search(cfg, { query: "widget calibration", limit: 5 });
  expect(fresh.retrievalTrail?.degraded.map((d) => d.code) ?? []).not.toContain(
    RETRIEVAL_DEGRADATION.hybridDeadlineExceeded,
  );
});
