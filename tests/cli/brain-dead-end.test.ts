/**
 * `o2b brain dead-end` CLI surface (t_be62c62d): record and list the
 * negative-knowledge registry.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listDeadEnds } from "../../src/core/brain/dead-ends.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-dead-end-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("record persists a dead-end note; list renders it", async () => {
  const rec = await runCli([
    "brain",
    "dead-end",
    "record",
    "--vault",
    vault,
    "--approach",
    "Polling the dashboard every second",
    "--reason",
    "Rate limits made the queue collapse",
    "--context",
    "kanban wrapper rework",
    "--json",
  ]);
  expect(rec.returncode).toBe(0);
  const body = JSON.parse(rec.stdout) as { ok: boolean; id: string };
  expect(body.ok).toBe(true);
  expect(body.id).toContain("polling-the-dashboard");
  expect(listDeadEnds(vault).entries).toHaveLength(1);

  const list = await runCli(["brain", "dead-end", "list", "--vault", vault, "--json"]);
  expect(list.returncode).toBe(0);
  const listed = JSON.parse(list.stdout) as {
    entries: Array<{ approach: string; reason: string; context: string | null }>;
  };
  expect(listed.entries[0]!.approach).toBe("Polling the dashboard every second");
  expect(listed.entries[0]!.reason).toContain("Rate limits");
  expect(listed.entries[0]!.context).toBe("kanban wrapper rework");
});

test("record without required flags exits 2", async () => {
  const res = await runCli(["brain", "dead-end", "record", "--vault", vault, "--approach", "x"]);
  expect(res.returncode).toBe(2);
});

test("unknown op exits 2", async () => {
  const res = await runCli(["brain", "dead-end", "bogus", "--vault", vault]);
  expect(res.returncode).toBe(2);
});
