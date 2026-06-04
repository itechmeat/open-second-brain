/**
 * `o2b brain activation` CLI surface (Time-Aware Recall & Activation
 * Suite, t_2bc79017): status and sweep over the activation event store.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordAccessEvent } from "../../src/core/search/activation/store.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-activation-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("status reports the folded activation state", async () => {
  const now = Date.now();
  recordAccessEvent(vault, {
    ts: now - 1000,
    queryHash: "abcd0001",
    paths: ["Brain/notes/a.md", "Brain/notes/b.md"],
  });
  recordAccessEvent(vault, {
    ts: now,
    queryHash: "abcd0002",
    paths: ["Brain/notes/a.md"],
  });
  const res = await runCli(["brain", "activation", "status", "--vault", vault, "--json"]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    events: number;
    paths: number;
    co_access_pairs: number;
    top: Array<{ path: string; access_count: number }>;
  };
  expect(body.events).toBe(2);
  expect(body.paths).toBe(2);
  expect(body.co_access_pairs).toBe(1);
  expect(body.top[0]?.path).toBe("Brain/notes/a.md");
  expect(body.top[0]?.access_count).toBe(2);
});

test("status on an empty vault is a zero envelope, not an error", async () => {
  const res = await runCli(["brain", "activation", "status", "--vault", vault, "--json"]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { events: number };
  expect(body.events).toBe(0);
});

test("sweep drops events beyond the cap and reports counts", async () => {
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    recordAccessEvent(vault, {
      ts: now - i * 1000,
      queryHash: "abcd0003",
      paths: [`Brain/n${i}.md`],
    });
  }
  const res = await runCli([
    "brain",
    "activation",
    "sweep",
    "--max-events",
    "2",
    "--vault",
    vault,
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { removed: number; kept: number };
  expect(body.removed).toBe(3);
  expect(body.kept).toBe(2);
});

test("an unknown operation exits 2 with usage", async () => {
  const res = await runCli(["brain", "activation", "bogus", "--vault", vault]);
  expect(res.returncode).toBe(2);
});
