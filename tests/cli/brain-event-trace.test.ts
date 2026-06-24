/**
 * `o2b brain event-trace` CLI surface: usage errors (bad --kind / --limit,
 * malformed selectors) exit with code 2 and a plain stderr message, distinct
 * from the exit-1 runtime-failure path. A clean run over an empty log exits 0.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-event-trace-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("an unknown --kind is a usage error (exit 2, plain stderr)", async () => {
  const r = await runCli(["brain", "event-trace", "--vault", vault, "--kind", "not-a-kind"]);
  expect(r.returncode).toBe(2);
  expect(r.stderr).toContain("unknown event kind");
});

test("a non-positive --limit is a usage error (exit 2)", async () => {
  const r = await runCli(["brain", "event-trace", "--vault", vault, "--limit", "0"]);
  expect(r.returncode).toBe(2);
  expect(r.stderr).toContain("--limit");
});

test("a malformed --at selector is a usage error (exit 2)", async () => {
  const r = await runCli(["brain", "event-trace", "--vault", vault, "--at", "10am"]);
  expect(r.returncode).toBe(2);
});

test("a clean run over an empty log exits 0", async () => {
  const r = await runCli(["brain", "event-trace", "--vault", vault, "--json"]);
  expect(r.returncode).toBe(0);
});
