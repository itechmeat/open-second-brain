/**
 * `o2b brain benchmark` + `o2b brain tune` CLI surfaces
 * (t_e2215d49 / t_ae973491): benchmark scores a dataset and records
 * the recall_benchmark metric; tune runs the grid, persists, reports
 * status, and resets; search --expand reaches the expansion path.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { listMetrics } from "../../src/core/brain/metrics.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let datasetPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-bench-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(
    join(vault, "canary.md"),
    "# Canary rollout\n\nShip one instance first, observe, expand gradually.\n",
  );
  // "the" is seeded across >= 2 of the other notes (majority of the
  // corpus) but NOT canary.md, so the DF-driven, language-agnostic
  // common-token filter drops it from the implicit-AND lex lane.
  writeFileSync(join(vault, "other.md"), "# Other\n\nNothing in the list is relevant here.\n");
  writeFileSync(join(vault, "notes.md"), "# Notes\n\nThe team reviewed the plan in the meeting.\n");
  datasetPath = join(tmp, "dataset.json");
  writeFileSync(
    datasetPath,
    JSON.stringify({
      queries: [{ id: "canary", query: "canary rollout", expected: ["canary.md"] }],
    }),
  );
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("benchmark run scores the dataset and records the metric", async () => {
  const r = await runCli([
    "brain",
    "benchmark",
    "run",
    "--dataset",
    datasetPath,
    "--vault",
    vault,
    "--json",
  ]);
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { total: number; hit_at_k: number; mrr: number };
  expect(parsed.total).toBe(1);
  expect(parsed.hit_at_k).toBe(1);
  expect(parsed.mrr).toBe(1);

  const metrics = listMetrics(vault, { surface: "recall_benchmark" });
  expect(metrics).toHaveLength(1);
  expect(metrics[0]!.payload).toMatchObject({ total: 1, hit_at_k: 1 });
});

test("benchmark usage and dataset validation exit 2", async () => {
  const noDataset = await runCli(["brain", "benchmark", "run", "--vault", vault]);
  expect(noDataset.returncode).toBe(2);

  const badPath = join(tmp, "bad.json");
  writeFileSync(badPath, JSON.stringify({ queries: [] }));
  const bad = await runCli(["brain", "benchmark", "run", "--dataset", badPath, "--vault", vault]);
  expect(bad.returncode).toBe(2);
});

test("tune run -> status -> reset lifecycle with the self_tuning metric", async () => {
  const run = await runCli([
    "brain",
    "tune",
    "run",
    "--dataset",
    datasetPath,
    "--vault",
    vault,
    "--json",
  ]);
  expect(run.returncode).toBe(0);
  const ran = JSON.parse(run.stdout) as {
    chosen: { poolMultiplier: number };
    evaluated: unknown[];
  };
  expect(ran.evaluated).toHaveLength(24);
  expect([3, 4, 5]).toContain(ran.chosen.poolMultiplier);
  expect(existsSync(join(vault, "Brain", "search", "tuning.json"))).toBe(true);
  expect(listMetrics(vault, { surface: "self_tuning" })).toHaveLength(1);

  const status = await runCli(["brain", "tune", "status", "--vault", vault, "--json"]);
  const state = JSON.parse(status.stdout) as { enabled: boolean; tuned: unknown };
  expect(state.enabled).toBe(false);
  expect(state.tuned).not.toBeNull();

  const reset = await runCli(["brain", "tune", "reset", "--vault", vault, "--json"]);
  expect(JSON.parse(reset.stdout)).toMatchObject({ removed: true });
  const statusAfter = await runCli(["brain", "tune", "status", "--vault", vault, "--json"]);
  expect((JSON.parse(statusAfter.stdout) as { tuned: unknown }).tuned).toBeNull();
});

test("tune run without a dataset exits 2", async () => {
  const r = await runCli(["brain", "tune", "run", "--vault", vault]);
  expect(r.returncode).toBe(2);
});

test("search --expand recovers the stopword-blocked hit", async () => {
  // "the" appears nowhere in canary.md, so the implicit-AND lane misses.
  const plain = await runCli(["search", "the canary rollout", "--vault", vault, "--json"]);
  expect(JSON.parse(plain.stdout).results).toHaveLength(0);
  const expanded = await runCli([
    "search",
    "the canary rollout",
    "--expand",
    "--vault",
    vault,
    "--json",
  ]);
  const results = JSON.parse(expanded.stdout).results as Array<{ path: string }>;
  expect(results.some((r) => r.path === "canary.md")).toBe(true);
});
