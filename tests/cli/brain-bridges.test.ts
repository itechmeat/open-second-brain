/**
 * `o2b brain bridges` CLI surface (t_ab540afe): discover regenerates
 * the proposals artifact and records the bridge_discovery metric;
 * accept/dismiss manage one pair; list reads the artifact back.
 * Fail-soft paths (no index, no embeddings) exit 0 with a reason.
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-bridges-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "a-note.md"), "# A note\n\nCanary deployment content here.\n");
  writeFileSync(join(vault, "b-note.md"), "# B note\n\nUnrelated content entirely.\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function indexWithoutEmbeddings(): Promise<void> {
  const config = makeConfig({
    vault,
    dbPath: join(vault, ".open-second-brain", "brain.sqlite"),
  });
  await indexVault(config);
}

test("discover on an unindexed vault exits 0 with a reason", async () => {
  const r = await runCli(["brain", "bridges", "discover", "--vault", vault, "--json"]);
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { vec_available: boolean; reason: string };
  expect(parsed.vec_available).toBe(false);
  expect(parsed.reason).toContain("index");
});

test("discover without embeddings writes the artifact, metric, and exits 0", async () => {
  await indexWithoutEmbeddings();
  const r = await runCli(["brain", "bridges", "discover", "--vault", vault, "--json"]);
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { vec_available: boolean; proposals: unknown[] };
  expect(parsed.vec_available).toBe(false);
  expect(parsed.proposals).toEqual([]);
  expect(existsSync(join(vault, "Brain", "proposals", "bridges.md"))).toBe(true);
  const metrics = listMetrics(vault, { surface: "bridge_discovery" });
  expect(metrics).toHaveLength(1);
  expect(metrics[0]!.payload["vec_available"]).toBe(false);
});

test("list before and after discover", async () => {
  const before = await runCli(["brain", "bridges", "list", "--vault", vault, "--json"]);
  expect(JSON.parse(before.stdout)).toMatchObject({ exists: false });

  await indexWithoutEmbeddings();
  await runCli(["brain", "bridges", "discover", "--vault", vault]);
  const after = await runCli(["brain", "bridges", "list", "--vault", vault, "--json"]);
  const parsed = JSON.parse(after.stdout) as { exists: boolean; proposals: number };
  expect(parsed.exists).toBe(true);
  expect(parsed.proposals).toBe(0);
});

test("accept writes related into the source and is idempotent", async () => {
  const first = await runCli([
    "brain",
    "bridges",
    "accept",
    "a-note.md",
    "b-note.md",
    "--vault",
    vault,
    "--json",
  ]);
  expect(first.returncode).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ changed: true, related: ["[[b-note]]"] });

  const again = await runCli([
    "brain",
    "bridges",
    "accept",
    "a-note.md",
    "b-note.md",
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(again.stdout)).toMatchObject({ changed: false });
});

test("dismiss persists and reports repeats", async () => {
  const first = await runCli([
    "brain",
    "bridges",
    "dismiss",
    "a-note.md",
    "b-note.md",
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(first.stdout)).toMatchObject({ added: true });
  const again = await runCli([
    "brain",
    "bridges",
    "dismiss",
    "b-note.md",
    "a-note.md",
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(again.stdout)).toMatchObject({ added: false });
});

test("usage errors exit 2", async () => {
  const r = await runCli(["brain", "bridges", "accept", "only-one.md", "--vault", vault]);
  expect(r.returncode).toBe(2);
  const bad = await runCli([
    "brain",
    "bridges",
    "discover",
    "--min-similarity",
    "5",
    "--vault",
    vault,
  ]);
  expect(bad.returncode).toBe(2);
});
