/**
 * `o2b brain label` CLI surface (t_7a41f42d): controlled-vocabulary
 * classification - assign validates fail-closed against the schema
 * pack, remove drops one dimension, show renders the current set.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-label-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    ["schema_version: 1", "schema:", "  labels:", "    - priority=low", "    - priority=high"].join(
      "\n",
    ) + "\n",
  );
  writeFileSync(join(vault, "Brain", "notes", "rollout.md"), "# Rollout\n\nCanary first.\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("assign writes the label, show renders it, remove drops it", async () => {
  const assign = await runCli([
    "brain",
    "label",
    "Brain/notes/rollout.md",
    "priority=high",
    "--vault",
    vault,
    "--json",
  ]);
  expect(assign.returncode).toBe(0);
  const assigned = JSON.parse(assign.stdout) as { ok: boolean; labels: string[] };
  expect(assigned.ok).toBe(true);
  expect(assigned.labels).toEqual(["priority/high"]);
  expect(readFileSync(join(vault, "Brain", "notes", "rollout.md"), "utf8")).toContain(
    "priority/high",
  );

  const show = await runCli([
    "brain",
    "label",
    "Brain/notes/rollout.md",
    "--show",
    "--vault",
    vault,
    "--json",
  ]);
  expect(show.returncode).toBe(0);
  expect(JSON.parse(show.stdout)).toEqual({
    ok: true,
    path: "Brain/notes/rollout.md",
    labels: ["priority/high"],
  });

  const remove = await runCli([
    "brain",
    "label",
    "Brain/notes/rollout.md",
    "--remove",
    "priority",
    "--vault",
    vault,
    "--json",
  ]);
  expect(remove.returncode).toBe(0);
  const removed = JSON.parse(remove.stdout) as { removed: boolean; labels: string[] };
  expect(removed.removed).toBe(true);
  expect(removed.labels).toEqual([]);
});

test("an out-of-vocabulary value is a usage error carrying the allowed list", async () => {
  const result = await runCli([
    "brain",
    "label",
    "Brain/notes/rollout.md",
    "priority=urgent",
    "--vault",
    vault,
  ]);
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain("allowed values: low, high");
});

test("missing mode or conflicting modes are usage errors", async () => {
  const none = await runCli(["brain", "label", "Brain/notes/rollout.md", "--vault", vault]);
  expect(none.returncode).toBe(2);
  const both = await runCli([
    "brain",
    "label",
    "Brain/notes/rollout.md",
    "priority=high",
    "--show",
    "--vault",
    vault,
  ]);
  expect(both.returncode).toBe(2);
});
