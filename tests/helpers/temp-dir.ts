/**
 * Temp directories a test file mints and is guaranteed to take back.
 *
 * A fixture builder that returns `mkdtempSync(...)` straight to its caller
 * hands off a directory nobody owns: the test reads it, asserts, and the
 * directory outlives the run. Enough of those filled the temp root with a
 * few hundred directories per full run (issue #194).
 *
 * `tempDirs()` is called once at module (or `describe`) scope. It registers
 * an `afterAll` that removes every directory the returned factory minted,
 * whether the tests passed or threw, so a builder only swaps
 * `mkdtempSync(join(tmpdir(), prefix))` for `mkTemp(prefix)`.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Recursive removal that rides out a transient Windows refusal. */
const REMOVE_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

export function tempDirs(): (prefix: string) => string {
  const minted: string[] = [];
  afterAll(() => {
    for (const dir of minted.splice(0)) rmSync(dir, REMOVE_TREE);
  });
  return (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    minted.push(dir);
    return dir;
  };
}

/**
 * Pin HOME to a fresh temp directory for the rest of this file.
 *
 * Bun runs many files in one process, so a module-scope
 * `process.env["HOME"] = mkdtempSync(...)` both leaks the directory and
 * leaks the pin into every later file. This hands HOME back and removes
 * the directory once the file's tests are done. Returns the pinned path.
 */
export function pinHome(prefix: string): string {
  const saved = process.env["HOME"];
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env["HOME"] = home;
  afterAll(() => {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
    rmSync(home, REMOVE_TREE);
  });
  return home;
}
