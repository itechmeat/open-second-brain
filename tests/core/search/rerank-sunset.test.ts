/**
 * The rerank sunset survey and the skip it drives: once a surveyed model's
 * announced shutdown date has passed, the cross-encoder stage makes no
 * request and the answer names `rerank-model-sunset` on its trail. Every
 * other verdict calls the endpoint exactly as before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { EmbeddingSunsetSurvey } from "../../../src/core/search/embeddings/sunset.ts";
import { parseIsoUtc } from "../../../src/core/brain/health/iso-time.ts";
import { applyCrossEncoderRerank } from "../../../src/core/search/rerank/index.ts";
import {
  RERANK_SUNSET_SURVEY,
  classifyRerankSunset,
  rerankSunsetHasPassed,
} from "../../../src/core/search/rerank/sunset.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { BrainSearchResult, ResolvedRerankConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const MODEL = "rerank-test";
const NOW_MS = parseIsoUtc("2026-10-01");
const PAST = "2026-01-01";
const FUTURE = "2027-06-01";
/** A model the shipped survey records as already shut down. */
const RETIRED_SHIPPED_MODEL = "rerank-english-v2.0";
/** A model the shipped survey records as an open-checkpoint negative. */
const NEGATIVE_SHIPPED_MODEL = "zeroentropy/zerank-2-reranker";

function result(id: number): BrainSearchResult {
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path: `note-${id}.md`,
    title: `Note ${id}`,
    content: `content ${id}`,
    startLine: 1,
    endLine: 2,
    score: 1 - id * 0.1,
    keywordScore: 0.5,
    semanticScore: 0.5,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "hybrid" as const,
    reasons: Object.freeze(["fts5_bm25: 0.500"]),
  });
}

const RESULTS = Object.freeze([result(1), result(2)]);

/** Rows in the persistent query cache of the index at `dbPath`. */
function queryCacheRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ c: number }, []>("SELECT count(*) AS c FROM query_cache").get()?.c ?? 0;
  } finally {
    db.close();
  }
}

function surveyWith(sunsetAt: string | null): EmbeddingSunsetSurvey {
  return {
    reviewedAt: "2026-09-30",
    entries: [{ model: MODEL, sunsetAt, source: "test survey", note: "" }],
  };
}

function rerankConfig(
  baseUrl: string,
  overrides: Partial<ResolvedRerankConfig> = {},
): ResolvedRerankConfig {
  return Object.freeze({
    enabled: true,
    kind: "openai-compat",
    baseUrl,
    model: MODEL,
    envKey: null,
    apiKey: "k",
    topK: 20,
    minScore: 0,
    ...overrides,
  });
}

describe("the shipped survey", () => {
  test("every entry owes a source, models are unique and the review date parses", () => {
    expect(Number.isFinite(parseIsoUtc(RERANK_SUNSET_SURVEY.reviewedAt))).toBe(true);
    const models = RERANK_SUNSET_SURVEY.entries.map((e) => e.model);
    expect(new Set(models).size).toBe(models.length);
    for (const entry of RERANK_SUNSET_SURVEY.entries) {
      expect(entry.source.trim().length).toBeGreaterThan(0);
      if (entry.sunsetAt !== null) expect(Number.isFinite(parseIsoUtc(entry.sunsetAt))).toBe(true);
    }
  });

  test("the retired second-generation Cohere rerank models are past their date", () => {
    for (const model of [RETIRED_SHIPPED_MODEL, "rerank-multilingual-v2.0"]) {
      const verdict = classifyRerankSunset(model, NOW_MS);
      expect(verdict.state).toBe("announced");
      expect(verdict.sunset_at).toBe("2025-04-30");
      expect(rerankSunsetHasPassed(verdict)).toBe(true);
    }
  });

  test("ZeroEntropy checkpoints are open-checkpoint negatives, never positives", () => {
    const zerank = RERANK_SUNSET_SURVEY.entries.filter((e) => e.model.includes("zerank"));
    expect(zerank.length).toBeGreaterThan(0);
    for (const entry of zerank) expect(entry.sunsetAt).toBeNull();
    expect(classifyRerankSunset(NEGATIVE_SHIPPED_MODEL, NOW_MS).state).toBe("none_announced");
  });

  test("the hosted ZeroEntropy ids are negatives; the two without a checkpoint stay unsurveyed", () => {
    for (const model of ["zerank-1", "zerank-1-small"]) {
      expect(classifyRerankSunset(model, NOW_MS).state).toBe("none_announced");
    }
    for (const model of ["zerank-2-small", "zerank-2-nano"]) {
      expect(classifyRerankSunset(model, NOW_MS).state).toBe("unsurveyed");
    }
  });

  test("only a passed announced date skips", () => {
    expect(rerankSunsetHasPassed(classifyRerankSunset(MODEL, NOW_MS, surveyWith(PAST)))).toBe(true);
    expect(rerankSunsetHasPassed(classifyRerankSunset(MODEL, NOW_MS, surveyWith(FUTURE)))).toBe(
      false,
    );
    expect(rerankSunsetHasPassed(classifyRerankSunset(MODEL, NOW_MS, surveyWith(null)))).toBe(
      false,
    );
    expect(rerankSunsetHasPassed(classifyRerankSunset("other", NOW_MS, surveyWith(PAST)))).toBe(
      false,
    );
    expect(rerankSunsetHasPassed(classifyRerankSunset(null, NOW_MS))).toBe(false);
  });
});

describe("the stage under an injected survey", () => {
  let fake: FakeHttp;
  beforeEach(async () => {
    fake = await startFakeHttp();
    fake.setHandler((req) => {
      const docs = (req.body as { documents: string[] }).documents;
      return { status: 200, body: docs.map((_d, index) => ({ index, score: index })) };
    });
  });
  afterEach(async () => {
    await fake.close();
  });

  async function run(
    survey: EmbeddingSunsetSurvey,
    overrides: Partial<ResolvedRerankConfig> = {},
  ): Promise<{ out: ReadonlyArray<BrainSearchResult>; skipped: number }> {
    let skipped = 0;
    const out = await applyCrossEncoderRerank(RESULTS, "q", rerankConfig(fake.url, overrides), {
      skipDecisionModel: true,
      sunset: {
        nowMs: NOW_MS,
        survey,
        onSkip: () => {
          skipped += 1;
        },
      },
    });
    return { out, skipped };
  }

  test("a passed date makes no request and returns the heuristic order", async () => {
    const { out, skipped } = await run(surveyWith(PAST));
    expect(fake.callCount()).toBe(0);
    expect(out).toBe(RESULTS);
    expect(skipped).toBe(1);
  });

  test("a future date, an off-survey model and a negative call the endpoint", async () => {
    const runs = await Promise.all(
      [surveyWith(FUTURE), surveyWith(null), { reviewedAt: "2026-09-30", entries: [] }].map(
        (survey) => run(survey),
      ),
    );
    for (const { out, skipped } of runs) {
      expect(skipped).toBe(0);
      expect(out.map((r) => r.documentId)).toEqual([2, 1]);
    }
    expect(fake.callCount()).toBe(3);
  });

  test("the local kind never consults the survey", async () => {
    // A passed date would skip an openai-compat request; the local
    // reranker is this build's own and has no vendor date to pass.
    const { skipped } = await run(surveyWith(PAST), { kind: "local" });
    expect(skipped).toBe(0);
    expect(fake.callCount()).toBe(0);
  });
});

describe("through search()", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;
  const realFetch = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("rerank-sunset"));
    writeMd(vault, "strong.md", "# Strong\n\nfox fox fox fox the quick brown fox jumps high.");
    writeMd(vault, "weak.md", "# Weak\n\nA note mostly about cats, with one fox mention here.");
    calls = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init.body)) as { documents: string[] };
      const results = body.documents.map((_d, index) => ({ index, relevance_score: index }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    cleanup();
  });

  function cfg(model: string) {
    return makeConfig({
      vault,
      dbPath,
      cacheEnabled: true,
      rerank: { enabled: true, baseUrl: "https://api.example.com/v1", model, apiKey: "k" },
    });
  }

  test("a retired model is skipped, named on the trail, and the outcome is cached", async () => {
    const config = cfg(RETIRED_SHIPPED_MODEL);
    await indexVault(config);
    const base = await search(makeConfig({ vault, dbPath }), { query: "fox", limit: 10 });
    const first = await search(config, { query: "fox", limit: 10 });
    expect(calls).toBe(0);
    expect(first.results.map((r) => r.path)).toEqual(base.results.map((r) => r.path));
    expect(first.retrievalTrail?.degraded).toContainEqual({
      code: RETRIEVAL_DEGRADATION.rerankModelSunset,
    });
    // Unlike an endpoint failure, a passed date is a stable verdict, so
    // the answer is written to the query cache.
    expect(queryCacheRows(dbPath)).toBe(1);
    const second = await search(config, { query: "fox", limit: 10 });
    expect(calls).toBe(0);
    expect(second.retrievalTrail).toEqual(first.retrievalTrail);
  });

  test("a surveyed negative calls the endpoint as before", async () => {
    const config = cfg(NEGATIVE_SHIPPED_MODEL);
    await indexVault(config);
    const out = await search(config, { query: "fox", limit: 10 });
    expect(calls).toBe(1);
    expect(out.retrievalTrail).toBeUndefined();
  });
});
