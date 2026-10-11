/**
 * Bilingual rerank-eval CI gate - the ZH half (recall-quality,
 * t_693fa22a / task D2).
 *
 * A bundled, self-authored Chinese fixture vault + dataset (12 queries,
 * 3 answer-bearing) scored through `runRerankEvalGate` on the OFFLINE
 * stack: the deterministic local embedding provider plus the bundled
 * jieba/tiny-segmenter CJK FTS expansion (`cjk-tokenizer.ts`). No model
 * call, no network: the run is reproducible byte for byte.
 *
 * What the pins prove and what they do not. The local provider is a
 * lexical feature-hashing baseline, so a green run certifies the CJK
 * path end to end - segmentation at index and query time, FTS expansion,
 * the hybrid fuse, and rerank ORDERING on Chinese text. It does NOT
 * measure real multilingual embedding semantics; that claim belongs to
 * the operator lane (`o2b search rerank-eval --dataset <zh-set>` against
 * a vault embedded with a multilingual preset).
 *
 * Pins are measured on the first run of this fixture, then frozen, one
 * failing-direction margin below (the EN gate's convention): the landing
 * measurement is hit@5 = 1.000, MRR = 1.000, answer-containment@5 =
 * 1.000. A fallen
 * number is the finding; a pin is never loosened to admit one. This
 * fixture is deliberately a SIBLING of `tests/fixtures/recall-benchmark/`
 * - adding ZH pages to that vault would move its EN denominators and its
 * measured-pins history, which stay untouched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  parseRecallBenchmarkDataset,
  runRecallBenchmark,
} from "../../../src/core/search/benchmark.ts";
import { runRerankEvalGate } from "../../../src/core/search/rerank-eval-gate.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "recall-benchmark-zh");

/**
 * CI thresholds - margin below the first-run measurement (2026-10-11:
 * hit@5 = 1.000, MRR = 1.000, answer-containment@5 = 1.000, every
 * expected path at rank 1). Re-measure whenever the fixture vault,
 * dataset, or ranking pipeline changes, and update this header. A pin is
 * never loosened to admit a measurement that fell.
 */
const MIN_HIT_AT_5 = 0.9;
const MIN_MRR = 0.85;
// Answer-containment floor over the three answer-bearing queries; the
// answers are verbatim substrings of their source notes, so a correct
// retrieval contains them.
const MIN_ANSWER_CONTAINMENT_AT_5 = 0.99;

let vault: string;
let config: ResolvedSearchConfig;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-bench-zh-"));
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

describe("the bundled zh fixture", () => {
  test("parses and every query declares zh", () => {
    const dataset = loadDataset();
    expect(dataset.queries.length).toBeGreaterThanOrEqual(10);
    for (const q of dataset.queries) expect(q.lang).toBe("zh");
  });

  test("the recall gate holds the pinned zh thresholds", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(report.hitAtK).toBeGreaterThanOrEqual(MIN_HIT_AT_5);
    expect(report.mrr).toBeGreaterThanOrEqual(MIN_MRR);
    expect(report.answerQueries).toBe(3);
    expect(report.answerContainmentAtK).toBeGreaterThanOrEqual(MIN_ANSWER_CONTAINMENT_AT_5);
  });

  test("the byLang split folds the whole run under zh", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(Object.keys(report.byLang)).toEqual(["zh"]);
    expect(report.byLang["zh"]!.total).toBe(report.total);
    expect(report.byLang["zh"]!.hitAtK).toBe(report.hitAtK);
    expect(report.byLang["zh"]!.mrr).toBe(report.mrr);
  });

  test("the rerank eval gate runs both arms offline and reports a verdict", async () => {
    const gate = await runRerankEvalGate(config, loadDataset(), { kind: "local", k: 5 });
    expect(["enable", "keep-disabled"]).toContain(gate.recommendation);
    // The offline stack is deterministic, so the comparison arms are too.
    expect(gate.reranked.hitAtK).toBeGreaterThanOrEqual(MIN_HIT_AT_5);
    expect(gate.baseline).toEqual(await runRecallBenchmark(config, loadDataset(), { k: 5 }));
  });

  test("the zh run is deterministic across gate invocations", async () => {
    const first = await runRerankEvalGate(config, loadDataset(), { kind: "local", k: 5 });
    const second = await runRerankEvalGate(config, loadDataset(), { kind: "local", k: 5 });
    expect(second).toEqual(first);
  });
});
