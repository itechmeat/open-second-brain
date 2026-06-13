/**
 * Recall benchmark CI gate (link-recall-intelligence, t_e2215d49):
 * the committed fixture vault + dataset score against the live hybrid
 * pipeline with the deterministic local embedding provider; pinned
 * thresholds fail the suite on a ranking regression. Measured on
 * 2026-06-05: hit@5 = 1.000, MRR = 0.958 - thresholds sit one
 * failing-direction margin below so legitimate ranking improvements
 * do not flap the gate.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  parseRecallBenchmarkDataset,
  runRecallBenchmark,
} from "../../../src/core/search/benchmark.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "recall-benchmark");

/**
 * CI thresholds - margin below the measured values above. Re-measure
 * (run the suite and read the report) whenever the fixture vault,
 * dataset, or ranking pipeline changes, and update both the pins and
 * the header comment.
 */
const MIN_HIT_AT_5 = 0.9;
const MIN_MRR = 0.85;
// Answer-containment floor over the answer-bearing fixture queries. The
// three answers are verbatim substrings of their source notes, so a
// correct retrieval contains them; the pin sits one failing-direction
// margin below the measured 1.0.
const MIN_ANSWER_CONTAINMENT_AT_5 = 0.99;

let vault: string;
let config: ResolvedSearchConfig;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-bench-"));
  cpSync(join(FIXTURE, "vault"), vault, { recursive: true });
  config = makeConfig({
    vault,
    dbPath: join(vault, "index.sqlite"),
    semantic: { enabled: true, provider: "local", dimension: 256 },
  });
  await indexVault(config, { embeddings: true });
});

afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
});

function loadDataset() {
  return parseRecallBenchmarkDataset(
    JSON.parse(readFileSync(join(FIXTURE, "dataset.json"), "utf8")),
  );
}

describe("parseRecallBenchmarkDataset", () => {
  test("accepts the committed dataset", () => {
    const dataset = loadDataset();
    expect(dataset.queries.length).toBeGreaterThanOrEqual(10);
  });

  test("rejects malformed datasets naming the offender", () => {
    expect(() => parseRecallBenchmarkDataset([])).toThrow(SearchError);
    expect(() => parseRecallBenchmarkDataset({ queries: [] })).toThrow(/non-empty/);
    expect(() =>
      parseRecallBenchmarkDataset({ queries: [{ id: "x", query: "q", expected: [] }] }),
    ).toThrow(/expected path/);
    expect(() =>
      parseRecallBenchmarkDataset({
        queries: [
          { id: "x", query: "q", expected: ["a.md"] },
          { id: "x", query: "q2", expected: ["b.md"] },
        ],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      parseRecallBenchmarkDataset({ queries: [{ id: "x", query: "q", expected: ["a.md"], k: 0 }] }),
    ).toThrow(/k must be/);
    expect(() =>
      parseRecallBenchmarkDataset({
        queries: [{ id: "x", query: "q", expected: ["a.md"], answer: "  " }],
      }),
    ).toThrow(/answer must be/);
  });
});

describe("runRecallBenchmark", () => {
  test("the fixture vault holds the pinned recall thresholds", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(report.total).toBe(12);
    expect(report.hitAtK).toBeGreaterThanOrEqual(MIN_HIT_AT_5);
    expect(report.mrr).toBeGreaterThanOrEqual(MIN_MRR);
  });

  test("answer-containment@k scores the answer-bearing queries and holds the pinned floor", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(report.answerQueries).toBe(3);
    expect(report.answerContainmentAtK).toBeGreaterThanOrEqual(MIN_ANSWER_CONTAINMENT_AT_5);
    // Queries without an answer report null containment, not a false miss.
    const noAnswer = report.perQuery.find((q) => q.id === "style")!;
    expect(noAnswer.answerContained).toBeNull();
  });

  test("an answer absent from the retrieved content scores a containment miss", async () => {
    const report = await runRecallBenchmark(
      config,
      parseRecallBenchmarkDataset({
        queries: [
          {
            id: "miss",
            query: "canary rollout",
            expected: ["deploy-canary.md"],
            answer: "this phrase appears in no note",
          },
        ],
      }),
      { k: 5 },
    );
    expect(report.answerQueries).toBe(1);
    expect(report.answerContainmentAtK).toBe(0);
    expect(report.perQuery[0]!.answerContained).toBe(false);
  });

  test("answer-containment is vacuously 1 for a dataset with no answers", async () => {
    const report = await runRecallBenchmark(
      config,
      parseRecallBenchmarkDataset({
        queries: [{ id: "plain", query: "canary rollout", expected: ["deploy-canary.md"] }],
      }),
      { k: 5 },
    );
    expect(report.answerQueries).toBe(0);
    expect(report.answerContainmentAtK).toBe(1);
  });

  test("the benchmark is deterministic across runs", async () => {
    const first = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    const second = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(second).toEqual(first);
  });

  test("the alias-hop query reaches the alias owner through traversal", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    const aliasHop = report.perQuery.find((q) => q.id === "alias-hop")!;
    expect(aliasHop.hit).toBe(true);
  });

  test("wrong expectations score as misses - the metric points the right way", async () => {
    const report = await runRecallBenchmark(
      config,
      parseRecallBenchmarkDataset({
        queries: [{ id: "wrong", query: "canary rollout", expected: ["recipe-borscht.md"] }],
      }),
      { k: 5 },
    );
    expect(report.hitAtK).toBe(0);
    expect(report.mrr).toBe(0);
    expect(report.perQuery[0]!.rank).toBeNull();
  });

  test("expand mode reports itself and keeps the gate", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5, expand: true });
    expect(report.expand).toBe(true);
    expect(report.hitAtK).toBeGreaterThanOrEqual(MIN_HIT_AT_5);
  });
});
