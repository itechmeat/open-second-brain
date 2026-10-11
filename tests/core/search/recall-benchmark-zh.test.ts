/**
 * Bilingual rerank-eval CI gate - the ZH half (recall-quality,
 * t_693fa22a / task D2).
 *
 * A bundled, self-authored Chinese fixture vault + dataset (22 queries,
 * 3 answer-bearing) scored through `runRerankEvalGate` on the OFFLINE
 * stack: the deterministic local embedding provider plus the bundled
 * jieba/tiny-segmenter CJK FTS expansion (`cjk-tokenizer.ts`). No model
 * call, no network: the run is reproducible byte for byte.
 *
 * What the pins prove and what they do not. The local provider is a
 * lexical feature-hashing baseline, so a green run certifies the CJK
 * path end to end - segmentation at index and query time, FTS expansion,
 * and the hybrid fuse. It does NOT measure real multilingual embedding
 * semantics; that claim belongs to the operator lane
 * (`o2b search rerank-eval --dataset <zh-set>` against a vault embedded
 * with a multilingual preset).
 *
 * The set is deliberately NON-saturated (t_693fa22a review, M14): beyond
 * the twelve queries the baseline ranks first it carries ten
 * paraphrase / synonym / mixed-script queries the lexical baseline does
 * NOT rank first - five miss the top 5 outright, the rest land at ranks
 * 2-3 - so a reranker that reorders CAN move every number here, and the
 * gate's verdict measures the reranker instead of the ceiling. The
 * landing measurement of that set (2026-10-11): hit@5 = 0.773,
 * MRR = 0.674, answer-containment@5 = 1.000, and the bundled lexical
 * reranker reorders nothing (both deltas exactly 0 - its tokenizer is
 * whitespace-oriented and cannot see inside Han character runs), so the
 * measured verdict is keep-disabled. A green run still certifies the
 * CJK path end to end; the re-saturation guard below keeps the set
 * honest. A fallen number is the finding; a pin is never loosened to
 * admit one. This fixture is deliberately a SIBLING of
 * `tests/fixtures/recall-benchmark/` - adding ZH pages to that vault
 * would move its EN denominators and its measured-pins history, which
 * stay untouched.
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
 * CI thresholds - margin below the first-run measurement of the
 * non-saturated set (2026-10-11: hit@5 = 0.773, MRR = 0.674,
 * answer-containment@5 = 1.000; five queries miss the top 5, the rest of
 * the new queries land at ranks 2-3). Re-measure whenever the fixture
 * vault, dataset, or ranking pipeline changes, and update this header.
 * A pin is never loosened to admit a measurement that fell.
 */
const MIN_HIT_AT_5 = 0.75;
const MIN_MRR = 0.65;
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

  test("the recall gate holds the pinned zh thresholds on a NON-saturated baseline", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(report.hitAtK).toBeGreaterThanOrEqual(MIN_HIT_AT_5);
    expect(report.mrr).toBeGreaterThanOrEqual(MIN_MRR);
    expect(report.answerQueries).toBe(3);
    expect(report.answerContainmentAtK).toBeGreaterThanOrEqual(MIN_ANSWER_CONTAINMENT_AT_5);
    // The re-saturation guard (M14): the set must keep queries the
    // baseline does not rank first, or a reranker could only ever tie or
    // lose and the gate measures the ceiling instead of the reranker. If
    // these tighten to 1.0 the set went blind again - add queries; never
    // delete this pin.
    expect(report.hitAtK).toBeLessThan(1);
    expect(report.mrr).toBeLessThan(1);
  });

  test("the byLang split folds the whole run under zh", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(Object.keys(report.byLang)).toEqual(["zh"]);
    expect(report.byLang["zh"]!.total).toBe(report.total);
    expect(report.byLang["zh"]!.hitAtK).toBe(report.hitAtK);
    expect(report.byLang["zh"]!.mrr).toBe(report.mrr);
  });

  test("the rerank eval gate runs both arms offline and pins the measured verdict", async () => {
    const gate = await runRerankEvalGate(config, loadDataset(), { kind: "local", k: 5 });
    // Measured on the non-saturated set (2026-10-11): the bundled lexical
    // reranker reorders nothing on this corpus - its whitespace-oriented
    // tokenizer cannot see inside Han runs, so every delta is exactly 0
    // and keep-disabled is a measurement, not the old structural verdict
    // that a perfect baseline forced. If either pin moves, re-measure and
    // re-pin consciously.
    expect(gate.recommendation).toBe("keep-disabled");
    expect(gate.deltas.hitAtK).toBe(0);
    expect(gate.deltas.mrr).toBe(0);
    // The per-language delta split (M14 part 2) reaches the single-group
    // run too: one zh entry, carrying the same zeros.
    expect(gate.deltas.byLang["zh"]).toEqual({ hitAtK: 0, mrr: 0 });
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
