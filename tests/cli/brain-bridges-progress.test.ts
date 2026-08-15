/**
 * `o2b brain bridges discover` under observation (nothing-runs-unwatched,
 * U1 + U3).
 *
 * The scan walks every candidate document in the index and, until now,
 * printed its first character after the last comparison. Two properties
 * hold at the boundary: the records go to stderr, and the payload a
 * caller parses does not move by one byte because someone asked to watch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { OPERATION } from "../../src/core/brain/safeguard.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { progressRecords, STAGE_IDENTIFIER } from "../helpers/progress-records.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-bridges-progress-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "a-note.md"), "# A note\n\nCanary deployment content here.\n");
  writeFileSync(join(vault, "b-note.md"), "# B note\n\nUnrelated content entirely.\n");
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("o2b brain bridges discover --progress", () => {
  test("writes records to stderr and leaves stdout untouched", async () => {
    const plain = await runCli(["brain", "bridges", "discover", "--vault", vault, "--json"]);
    const watched = await runCli([
      "brain",
      "bridges",
      "discover",
      "--vault",
      vault,
      "--json",
      "--progress",
    ]);

    expect(plain.returncode).toBe(0);
    expect(watched.returncode).toBe(0);
    // `generated_at` lives in the artifact, not the payload, so the two
    // runs are comparable byte for byte.
    expect(watched.stdout).toBe(plain.stdout);

    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r["operation"] === OPERATION.bridges)).toBe(true);
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });

  test("integers and identifiers only - no prose on the structured stream", async () => {
    const watched = await runCli(["brain", "bridges", "discover", "--vault", vault, "--progress"]);
    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(String(record["stage"])).toMatch(STAGE_IDENTIFIER);
      expect(Number.isInteger(record["completed"])).toBe(true);
    }
  });

  test("without the flag nobody is watching, and the run is unchanged", async () => {
    const plain = await runCli(["brain", "bridges", "discover", "--vault", vault]);
    expect(plain.returncode).toBe(0);
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });
});
