/**
 * `o2b brain clusters run` under observation (nothing-runs-unwatched,
 * U1 + U3).
 *
 * Label propagation sweeps the whole link graph until no label moves, and
 * the sweep count is a ceiling rather than a schedule - so a caller
 * genuinely cannot tell a slow graph from a stuck one without a stream.
 * The records land on stderr and the payload does not move.
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
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-clusters-progress-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const group = ["team-a", "team-b", "team-c", "team-d"];
  for (const name of group) {
    const others = group
      .filter((g) => g !== name)
      .map((g) => `[[${g}]]`)
      .join(" ");
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nSee ${others}.\n`);
  }
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("o2b brain clusters run --progress", () => {
  test("writes records to stderr and leaves stdout untouched", async () => {
    const plain = await runCli(["brain", "clusters", "run", "--vault", vault, "--json"]);
    const watched = await runCli([
      "brain",
      "clusters",
      "run",
      "--vault",
      vault,
      "--json",
      "--progress",
    ]);

    expect(plain.returncode).toBe(0);
    expect(watched.returncode).toBe(0);
    expect(watched.stdout).toBe(plain.stdout);

    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r["operation"] === OPERATION.clusters)).toBe(true);
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });

  test("integers and identifiers only - no prose on the structured stream", async () => {
    const watched = await runCli(["brain", "clusters", "run", "--vault", vault, "--progress"]);
    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(String(record["stage"])).toMatch(STAGE_IDENTIFIER);
      expect(Number.isInteger(record["completed"])).toBe(true);
      // The sweep ceiling IS known before the loop, unlike the index
      // walk, so this stream carries a denominator a renderer can use.
      expect(Number.isInteger(record["total"])).toBe(true);
    }
  });

  test("without the flag nobody is watching, and the run is unchanged", async () => {
    const plain = await runCli(["brain", "clusters", "run", "--vault", vault]);
    expect(plain.returncode).toBe(0);
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });
});
