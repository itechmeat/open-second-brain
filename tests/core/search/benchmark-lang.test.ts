/**
 * Per-language rerank-eval split (recall-quality, t_693fa22a / task D1).
 *
 * The dataset schema grows an optional `lang` tag (validated like
 * `answer`: a non-empty string when present, defaulting to "en"), and the
 * benchmark report folds a `byLang` aggregate out of `perQuery` with the
 * same reduce the overall report already uses - one fold, run per
 * language group, never a second scorer. The change is additive to the
 * RETURN VALUE: the benchmark emits no record and no schema version
 * moves, so existing datasets without a `lang` field stay valid and the
 * single-language report keeps its numbers.
 *
 * The offline ZH fixture gate that consumes the split lives in
 * `recall-benchmark-zh.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseRecallBenchmarkDataset,
  runRecallBenchmark,
  type RecallBenchmarkQueryResult,
} from "../../../src/core/search/benchmark.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { SearchError, type ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { runCli } from "../../helpers/run-cli.ts";

// The CLI section below drives the real `o2b` command line.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

describe("parseRecallBenchmarkDataset lang field", () => {
  test("an absent lang defaults to en", () => {
    const dataset = parseRecallBenchmarkDataset({
      queries: [{ id: "q1", query: "canary rollout", expected: ["deploy-canary.md"] }],
    });
    expect(dataset.queries[0]!.lang).toBe("en");
  });

  test("an explicit lang is preserved verbatim", () => {
    const dataset = parseRecallBenchmarkDataset({
      queries: [{ id: "q1", query: "灰度发布", expected: ["zh-canary.md"], lang: "zh" }],
    });
    expect(dataset.queries[0]!.lang).toBe("zh");
  });

  test("a blank or non-string lang is refused naming the field, like answer", () => {
    expect(() =>
      parseRecallBenchmarkDataset({
        queries: [{ id: "x", query: "q", expected: ["a.md"], lang: "   " }],
      }),
    ).toThrow(SearchError);
    expect(() =>
      parseRecallBenchmarkDataset({
        queries: [{ id: "x", query: "q", expected: ["a.md"], lang: "   " }],
      }),
    ).toThrow(/lang must be a non-empty string when present/);
    expect(() =>
      parseRecallBenchmarkDataset({
        queries: [{ id: "x", query: "q", expected: ["a.md"], lang: 42 }],
      }),
    ).toThrow(/lang must be a non-empty string when present/);
  });
});

// ----- the byLang fold -------------------------------------------------------

/** The same reduce the overall report applies, written out for comparison. */
function foldExpected(rows: ReadonlyArray<RecallBenchmarkQueryResult>) {
  const hits = rows.filter((r) => r.hit).length;
  const answerScored = rows.filter((r) => r.answerContained !== null);
  const answerHits = answerScored.filter((r) => r.answerContained === true).length;
  const foundTotal = rows.reduce((sum, r) => sum + r.expectedFound, 0);
  const declaredTotal = rows.reduce((sum, r) => sum + r.expectedTotal, 0);
  const hitRanks = rows.filter((r) => r.rank !== null).map((r) => r.rank!);
  return {
    total: rows.length,
    hitAtK: hits / rows.length,
    mrr: rows.reduce((sum, r) => sum + r.reciprocalRank, 0) / rows.length,
    answerQueries: answerScored.length,
    answerContainmentAtK: answerScored.length === 0 ? 1 : answerHits / answerScored.length,
    sourceUtilizationAtK: declaredTotal === 0 ? 1 : foundTotal / declaredTotal,
    citationDepth:
      hitRanks.length === 0 ? 0 : hitRanks.reduce((sum, r) => sum + r, 0) / hitRanks.length,
    sourceWarnings: rows.length - hits,
  };
}

describe("runRecallBenchmark byLang fold", () => {
  let vault: string;
  let config: ResolvedSearchConfig;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "o2b-bench-lang-"));
    // Self-authored two-language mini corpus: the same note in each
    // language is a different page, so each group has its own hit and
    // its own miss candidate and the fold has something to separate.
    writeMd(
      vault,
      "deploy-canary.md",
      "# Canary rollouts\n\nExpand the rollout gradually and watch the error budget before widening.",
    );
    writeMd(
      vault,
      "garden.md",
      "# Balcony garden\n\nTomatoes and basil move to the south planter in spring; turn the compost two weeks ahead.",
    );
    writeMd(
      vault,
      "zh-canary.md",
      "# 灰度发布笔记\n\n金丝雀发布先把小部分流量切到新版本，再逐步扩大范围，扩量之前要盯住错误预算并演练一次回滚。",
    );
    writeMd(
      vault,
      "zh-garden.md",
      "# 阳台种植笔记\n\n春季把番茄和罗勒移到朝南的花箱，堆肥提前两周翻一次，浇水选在清晨进行。",
    );
    config = makeConfig({
      vault,
      dbPath: join(vault, "index.sqlite"),
      semantic: { enabled: true, provider: "local", dimension: 256 },
    });
    await indexVault(config, { embeddings: true });
  });

  afterAll(() => rmSync(vault, { recursive: true, force: true }));

  const mixedDataset = () =>
    parseRecallBenchmarkDataset({
      queries: [
        {
          id: "en-canary",
          query: "canary rollout error budget",
          expected: ["deploy-canary.md"],
          answer: "expand the rollout gradually",
        },
        { id: "en-garden", query: "compost tomato balcony", expected: ["garden.md"] },
        {
          id: "zh-canary",
          query: "金丝雀发布 错误预算",
          expected: ["zh-canary.md"],
          answer: "错误预算",
          lang: "zh",
        },
        { id: "zh-garden", query: "阳台种植 番茄", expected: ["zh-garden.md"], lang: "zh" },
      ],
    });

  test("perQuery rows carry their language and untagged rows read en", async () => {
    const report = await runRecallBenchmark(config, mixedDataset(), { k: 5 });
    expect(report.perQuery.map((q) => q.lang)).toEqual(["en", "en", "zh", "zh"]);
  });

  test("byLang partitions perQuery and folds each group with the overall reduce", async () => {
    const report = await runRecallBenchmark(config, mixedDataset(), { k: 5 });
    expect(Object.keys(report.byLang).toSorted()).toEqual(["en", "zh"]);
    expect(report.byLang["en"]!.total).toBe(2);
    expect(report.byLang["zh"]!.total).toBe(2);
    // The language aggregate IS the overall fold applied to the group.
    expect(report.byLang["en"]).toEqual(
      foldExpected(report.perQuery.filter((q) => q.lang === "en")),
    );
    expect(report.byLang["zh"]).toEqual(
      foldExpected(report.perQuery.filter((q) => q.lang === "zh")),
    );
    // Answer-bearing queries are counted per group, not pooled.
    expect(report.byLang["en"]!.answerQueries).toBe(1);
    expect(report.byLang["zh"]!.answerQueries).toBe(1);
    // The overall numbers stay the pooled ones the report always had.
    expect(report.total).toBe(4);
    expect(report.answerQueries).toBe(2);
  });

  test("a dataset without any lang tag folds under en alone", async () => {
    const report = await runRecallBenchmark(
      config,
      parseRecallBenchmarkDataset({
        queries: [{ id: "plain", query: "canary rollout", expected: ["deploy-canary.md"] }],
      }),
      { k: 5 },
    );
    expect(Object.keys(report.byLang)).toEqual(["en"]);
    expect(report.byLang["en"]!.total).toBe(1);
  });

  test("the split is deterministic across runs", async () => {
    const first = await runRecallBenchmark(config, mixedDataset(), { k: 5 });
    const second = await runRecallBenchmark(config, mixedDataset(), { k: 5 });
    expect(second).toEqual(first);
  });
});

// ----- the CLI renders the split ---------------------------------------------

describe("o2b search rerank-eval language split", () => {
  let tmp: string;
  let vault: string;
  let configPath: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "osb-rerank-eval-lang-"));
    vault = join(tmp, "vault");
    mkdirSync(vault, { recursive: true });
    configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, `vault: "${vault}"\n`);
    writeMd(vault, "ml.md", "# Machine learning\n\nGradient descent optimizes the loss surface.\n");
    writeMd(vault, "zh-ml.md", "# 机器学习笔记\n\n梯度下降法沿着损失面往下走，逐步逼近极小值。\n");
    writeFileSync(
      join(tmp, "dataset.json"),
      JSON.stringify({
        queries: [
          { id: "en-q", query: "gradient descent", expected: ["ml.md"] },
          { id: "zh-q", query: "梯度下降 损失", expected: ["zh-ml.md"], lang: "zh" },
        ],
      }),
    );
    const env = { OPEN_SECOND_BRAIN_CONFIG: configPath };
    const indexed = await runCli(["search", "index", "--config", configPath], { env });
    expect(indexed.returncode).toBe(0);
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const args = (extra: ReadonlyArray<string> = []) => [
    "search",
    "rerank-eval",
    "--config",
    configPath,
    "--dataset",
    join(tmp, "dataset.json"),
    ...extra,
  ];

  test("--json carries a by_lang block on every arm", async () => {
    const res = await runCli(args(["--json"]), { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
    expect(res.returncode).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, Record<string, unknown>>;
    expect(out["baseline"]!["by_lang"]).toMatchObject({
      en: { total: 1 },
      zh: { total: 1 },
    });
    expect(out["local"]!["by_lang"]).toMatchObject({
      en: { total: 1 },
      zh: { total: 1 },
    });
  });

  test("text output renders one line per language per arm", async () => {
    const res = await runCli(args(), { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("en: 1 query(ies)");
    expect(res.stdout).toContain("zh: 1 query(ies)");
  });
});
