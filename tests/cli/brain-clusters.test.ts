/**
 * `o2b brain clusters` CLI surface (t_4ba927ec): run detects
 * communities, materializes derived notes, records the communities
 * metric; list reads them back; the maintenance lane executes the
 * bridges and clusters tasks under its lease.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { listMetrics } from "../../src/core/brain/metrics.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-clusters-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const group = ["team-a", "team-b", "team-c", "team-d"];
  for (const name of group) {
    const others = group
      .filter((g) => g !== name)
      .map((g) => `[[${g}]]`)
      .join(" ");
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nSee ${others}.\n`);
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function index(): Promise<void> {
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
}

test("run on an unindexed vault exits 0 with a reason", async () => {
  const r = await runCli(["brain", "clusters", "run", "--vault", vault, "--json"]);
  expect(r.returncode).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ communities: 0, reason: "index not built" });
});

test("run materializes the community, records the metric, list reads it back", async () => {
  await index();
  const run = await runCli(["brain", "clusters", "run", "--vault", vault, "--json"]);
  expect(run.returncode).toBe(0);
  const parsed = JSON.parse(run.stdout) as {
    communities: Array<{ id: string; size: number }>;
    written: string[];
    graph: { documents: number; linked_nodes: number; edges: number };
  };
  expect(parsed.communities).toHaveLength(1);
  expect(parsed.communities[0]!.size).toBe(4);
  expect(parsed.written).toHaveLength(1);
  // Unit 4: O(1) graph stats from the precomputed snapshot. The seeded
  // 4-clique has 4 linked nodes and 6 undirected edges.
  expect(parsed.graph.linked_nodes).toBe(4);
  expect(parsed.graph.edges).toBe(6);

  const metrics = listMetrics(vault, { surface: "communities" });
  expect(metrics).toHaveLength(1);
  expect(metrics[0]!.payload).toMatchObject({ communities: 1, written: 1 });

  const list = await runCli(["brain", "clusters", "list", "--vault", vault, "--json"]);
  const listed = JSON.parse(list.stdout) as { clusters: Array<{ size: number }> };
  expect(listed.clusters).toHaveLength(1);
  expect(listed.clusters[0]!.size).toBe(4);
});

test("min-size above the community suppresses it", async () => {
  await index();
  const run = await runCli([
    "brain",
    "clusters",
    "run",
    "--min-size",
    "5",
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(run.stdout)).toMatchObject({ communities: [] });
});

test("maintenance lane executes the bridges and clusters tasks", async () => {
  // dream needs an initialised Brain config.
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  const r = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"]);
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as {
    verdict: string;
    tasks: Array<{ name: string; ok: boolean }>;
  };
  expect(parsed.verdict).toBe("run");
  const names = parsed.tasks.map((t) => t.name);
  expect(names).toEqual(["dream", "reindex", "bridges", "clusters"]);
  expect(parsed.tasks.every((t) => t.ok)).toBe(true);
  // The lane's reindex built the index, so both passes left a metric.
  expect(listMetrics(vault, { surface: "bridge_discovery" })).toHaveLength(1);
  expect(listMetrics(vault, { surface: "communities" })).toHaveLength(1);
});

test("run --batch-size returns per-batch results", async () => {
  await index();
  const run = await runCli([
    "brain",
    "clusters",
    "run",
    "--batch-size",
    "1",
    "--vault",
    vault,
    "--json",
  ]);
  expect(run.returncode).toBe(0);
  const parsed = JSON.parse(run.stdout) as {
    communities: unknown[];
    batches: Array<{ index: number; start: number; end: number; error?: string }>;
  };
  expect(parsed.communities).toHaveLength(1);
  expect(parsed.batches).toHaveLength(1);
  expect(parsed.batches[0]).toMatchObject({ index: 0, start: 0, end: 1 });
  expect(parsed.batches[0]!.error).toBeUndefined();
  expect(listMetrics(vault, { surface: "communities" })[0]!.payload).toMatchObject({
    batches: 1,
    failed_batches: 0,
  });
});

test("run without --batch-size omits the batches field", async () => {
  await index();
  const run = await runCli(["brain", "clusters", "run", "--vault", vault, "--json"]);
  expect(JSON.parse(run.stdout)).not.toHaveProperty("batches");
});

test("usage errors exit 2", async () => {
  const r = await runCli(["brain", "clusters", "nope", "--vault", vault]);
  expect(r.returncode).toBe(2);
  const bad = await runCli(["brain", "clusters", "run", "--min-size", "0", "--vault", vault]);
  expect(bad.returncode).toBe(2);
  const badBatch = await runCli([
    "brain",
    "clusters",
    "run",
    "--batch-size",
    "0",
    "--vault",
    vault,
  ]);
  expect(badBatch.returncode).toBe(2);
});
