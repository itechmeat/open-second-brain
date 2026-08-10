/**
 * The in-process CLI runner owns process-wide state, so overlapping runs
 * corrupt each other. That corruption used to be silent and to surface
 * somewhere else entirely: a test file that ran three verbs through
 * `Promise.all` left a temp config path installed for the rest of the
 * process, and seventeen assertions in unrelated files failed with a vault
 * that could not be found. The refusal below is what turns that into an
 * error at the call site that caused it.
 */

import { expect, test } from "bun:test";

import { ConcurrentInProcessRunError, runCli } from "../helpers/run-cli.ts";

test("a second in-process run refuses while the first is still open", async () => {
  const first = runCli(["--help"]);
  await expect(runCli(["--help"])).rejects.toThrow(ConcurrentInProcessRunError);
  await first;
});

test("the guard clears, so sequential runs keep working", async () => {
  const first = await runCli(["--help"]);
  expect(first.returncode).toBe(0);
  const second = await runCli(["--help"]);
  expect(second.returncode).toBe(0);
});

test("a run that throws inside the CLI still clears the guard", async () => {
  // The flag is released in the same `finally` that restores the streams;
  // if it were released after the return, a failing command would wedge
  // every later run in the file.
  const failed = await runCli(["definitely-not-a-command"]);
  expect(failed.returncode).not.toBe(0);
  const after = await runCli(["--help"]);
  expect(after.returncode).toBe(0);
});

test("concurrency is available through the subprocess path", async () => {
  // The escape hatch the refusal points callers at owns none of the
  // process-global state, so it may overlap.
  const results = await Promise.all([
    runCli(["--help"], { subprocess: true }),
    runCli(["--help"], { subprocess: true }),
  ]);
  for (const result of results) expect(result.returncode).toBe(0);
});
