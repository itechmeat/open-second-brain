/**
 * `o2b search schema export` flag contract (t_50c81d5c, Task E4): the
 * usage string and every doc that names the verb
 * (docs/cli-reference.md, CHANGELOG.md, design.md) promise
 * `export [--stdout]`, where `--stdout` PRINTS the rendered artifact and
 * writes nothing - the dry-run/CI preview. The default (no flag) writes
 * the committed artifact and must stay byte-identical.
 *
 * `--json` is NOT advertised for export (it is `check`'s output mode),
 * yet `parseFlags` injects it into every schema, so export refuses it by
 * name instead of silently discarding it - a parsed-and-ignored flag on
 * this surface is exactly the defect class `--stdout` had.
 *
 * The tests mock `node:fs.writeFileSync` (bun `mock.module` retargets the
 * verb's named ESM import), so the red/green difference is observable
 * WITHOUT ever touching the real committed artifact, in either
 * direction - and the real module is handed back when the file ends, so
 * suites running later in the same process keep their writes.
 */

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { CliError } from "../../src/cli/argparse.ts";
import {
  SEARCH_QUERY_SCHEMA_PATH,
  cmdSearchSchema,
  renderSearchQueryArtifact,
} from "../../src/cli/search/verbs/schema-export.ts";

const written: Array<unknown[]> = [];

// Capture BEFORE the mock: the real writer, handed back in `afterAll`.
const REAL_WRITE_FILE_SYNC = fs.writeFileSync;

mock.module("node:fs", () => ({
  ...fs,
  writeFileSync: (...args: unknown[]) => {
    written.push(args);
  },
}));

/** The stdout the verb under test produced since the last drain. */
let stdout = "";

/** Run `cmdSearchSchema` with stdout captured into {@link stdout}. */
async function runExport(argv: ReadonlyArray<string>): Promise<number> {
  const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  try {
    return await cmdSearchSchema(argv);
  } finally {
    spy.mockRestore();
  }
}

describe("o2b search schema export flags", () => {
  afterEach(() => {
    written.length = 0;
    stdout = "";
  });

  /**
   * bun test runs every file of one invocation in a SINGLE process, so a
   * module mock left installed here would silently swallow
   * `writeFileSync` in every suite that runs after this one - the CLI
   * e2e suites write their vaults and configs through node:fs. Hand the
   * real module back before the runner moves on.
   */
  afterAll(() => {
    mock.module("node:fs", () => ({
      ...fs,
      writeFileSync: REAL_WRITE_FILE_SYNC,
    }));
  });

  test("--stdout prints the rendered artifact and writes nothing", async () => {
    const code = await runExport(["export", "--stdout"]);
    expect(code).toBe(0);
    expect(stdout).toBe(renderSearchQueryArtifact());
    expect(written).toEqual([]);
  });

  test("--json is refused by name, with the usage, and writes nothing", async () => {
    let caught: unknown;
    try {
      await runExport(["export", "--json"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("--json");
    expect(message).toContain("o2b search schema export [--stdout] | check");
    expect(written).toEqual([]);
  });

  test("the default (no flag) writes the committed path with the rendered bytes", async () => {
    const code = await runExport(["export"]);
    expect(code).toBe(0);
    expect(written).toEqual([[SEARCH_QUERY_SCHEMA_PATH, renderSearchQueryArtifact(), "utf8"]]);
    expect(stdout).toContain(`wrote ${SEARCH_QUERY_SCHEMA_PATH}`);
  });
});
