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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("a throw during setup clears the guard instead of wedging the process", async () => {
  // The flag used to be raised before the setup that resolves the
  // environment and reads the working directory, and process.cwd() throws
  // once the directory it names is deleted - routine in a suite that
  // chdirs into temp vaults and removes them. A throw in that window left
  // the flag raised for the rest of the process, and every later run
  // failed blaming a concurrency that never happened.
  const scratch = mkdtempSync(join(tmpdir(), "o2b-cwd-gone-"));
  const restore = process.cwd();
  process.chdir(scratch);
  rmSync(scratch, { recursive: true, force: true });
  try {
    const gone = await runCli(["--help"]);
    expect(gone.returncode).toBe(0);
  } finally {
    process.chdir(restore);
  }
  // The guard is clear, so the next run is not misdiagnosed as an overlap.
  const after = await runCli(["--help"]);
  expect(after.returncode).toBe(0);
});
