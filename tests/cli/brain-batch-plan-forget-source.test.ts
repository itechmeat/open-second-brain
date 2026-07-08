/**
 * CR #127.1 / #127.2: CLI error-contract fixes.
 *  #1 `brain batch-plan` with no <source-dir> is a USAGE error -> exit 2.
 *  #2 `brain forget-source --json` must emit a JSON error envelope (not
 *     plain-text) when a runtime failure is caught, so automation can parse it.
 */
import { expect, test } from "bun:test";
import { runCli } from "../helpers/run-cli.ts";

test("batch-plan without <source-dir> exits 2 (usage error) — CR #127.1", async () => {
  const r = await runCli(["brain", "batch-plan"]);
  expect(r.returncode).toBe(2);
  expect(r.stderr).toContain("usage:");
});

test("forget-source --json emits a JSON error envelope on runtime failure — CR #127.2", async () => {
  // No resolvable vault -> brainVerbContext throws inside the try, hitting the
  // catch. With --json the catch must return a parseable {ok:false} envelope.
  const r = await runCli(["brain", "forget-source", "ghost-source.md", "--json"]);
  expect(r.returncode).toBe(1);
  const parsed = JSON.parse(r.stdout.trim());
  expect(parsed.ok).toBe(false);
  expect(typeof parsed.message).toBe("string");
});
