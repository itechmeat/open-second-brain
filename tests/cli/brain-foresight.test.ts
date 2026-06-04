/**
 * `o2b brain foresight` CLI surface (t_08a79c81).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyRecurrenceEvidence } from "../../src/core/brain/recurrence.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-foresight-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("foresight renders an empty envelope on a fresh vault", async () => {
  const res = await runCli(["brain", "foresight", "--vault", vault, "--json"]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { version: number; upcoming: unknown[] };
  expect(body.version).toBe(1);
  expect(body.upcoming).toEqual([]);
});

test("foresight projects a routine and --write persists the note", async () => {
  const base = Date.now() - 21 * 24 * 3600 * 1000;
  for (let i = 0; i < 3; i++) {
    applyRecurrenceEvidence(vault, {
      contentHash: "routine1",
      scope: "weekly-review",
      sourceId: `s-${i}`,
      action: "learn",
      at: new Date(base + i * 7 * 24 * 3600 * 1000).toISOString(),
    });
  }
  const res = await runCli(["brain", "foresight", "--vault", vault, "--write", "--json"]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    upcoming: Array<{ kind: string; due: string | null }>;
    written_path: string;
  };
  expect(body.upcoming.some((u) => u.kind === "recurring")).toBe(true);
  expect(existsSync(body.written_path)).toBe(true);
});

test("invalid horizon exits 2", async () => {
  const res = await runCli(["brain", "foresight", "--vault", vault, "--horizon-days", "zero"]);
  expect(res.returncode).toBe(2);
});
