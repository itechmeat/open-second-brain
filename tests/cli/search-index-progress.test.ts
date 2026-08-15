/**
 * `o2b search index` and `o2b search reindex` under observation
 * (nothing-runs-unwatched, U1 + U3).
 *
 * These two carry a second, older stream: `--verbose` writes one
 * tab-separated line per file. The two answer different questions -
 * `onFile` says WHAT happened to each file, progress says HOW FAR the run
 * has got - and they share stderr, so the test that matters most here is
 * that adding one did not move the other by a byte.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPERATION } from "../../src/core/brain/safeguard.ts";
import { progressRecords, STAGE_IDENTIFIER } from "../helpers/progress-records.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

/** Everything on stderr that is NOT a progress record. */
function nonProgressLines(stderr: string): ReadonlyArray<string> {
  return stderr.split("\n").filter((line) => !line.startsWith(`{"schema":"o2b.progress`));
}

function args(verb: string, ...rest: string[]): string[] {
  return ["search", verb, "--vault", vault, "--db", join(tmp, "index.sqlite"), ...rest];
}

/**
 * A run report with its wall-clock field removed, so two runs can be
 * compared for equality without pretending a duration is stable.
 */
function reportWithoutTiming(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as { duration_ms?: number };
  delete parsed.duration_ms;
  return parsed;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-index-progress-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  for (const name of ["alpha", "beta", "gamma"]) {
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nBody text for ${name}.\n`);
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("o2b search index --progress", () => {
  test("writes records to stderr and leaves stdout untouched", async () => {
    const plain = await runCli(args("index", "--json"));
    rmSync(join(tmp, "index.sqlite"), { force: true });
    const watched = await runCli(args("index", "--json", "--progress"));

    expect(plain.returncode).toBe(0);
    expect(watched.returncode).toBe(0);
    expect(reportWithoutTiming(watched.stdout)).toEqual(reportWithoutTiming(plain.stdout));

    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r["operation"] === OPERATION.reindex)).toBe(true);
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });

  test("integers and identifiers only - no prose on the structured stream", async () => {
    const watched = await runCli(args("index", "--progress"));
    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(String(record["stage"])).toMatch(STAGE_IDENTIFIER);
      expect(Number.isInteger(record["completed"])).toBe(true);
      // The walk consumes a generator, so it has no denominator to
      // report and must not invent one.
      expect(record["total"]).toBeUndefined();
    }
  });

  test("the --verbose file stream is unchanged by this unit", async () => {
    const verbose = await runCli(args("index", "--verbose"));
    rmSync(join(tmp, "index.sqlite"), { force: true });
    const both = await runCli(args("index", "--verbose", "--progress"));

    expect(verbose.returncode).toBe(0);
    expect(both.returncode).toBe(0);
    // Same lines, same order, same text: `--progress` is additive on this
    // stream, never a rewrite of the one that was already there.
    expect(nonProgressLines(both.stderr)).toEqual(verbose.stderr.split("\n"));
    expect(verbose.stderr).toContain("added\t");
    expect(progressRecords(verbose.stderr)).toHaveLength(0);
    expect(progressRecords(both.stderr).length).toBeGreaterThan(0);
  });
});

describe("o2b search reindex --progress", () => {
  test("writes records to stderr and leaves stdout untouched", async () => {
    const plain = await runCli(args("reindex", "--json"));
    const watched = await runCli(args("reindex", "--json", "--progress"));

    expect(plain.returncode).toBe(0);
    expect(watched.returncode).toBe(0);

    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r["operation"] === OPERATION.reindex)).toBe(true);
    for (const record of records) {
      expect(String(record["stage"])).toMatch(STAGE_IDENTIFIER);
    }
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });

  test("does not report finished until after the swap that makes the rebuild real", async () => {
    // A rebuild is not over when its build is: `indexVault` used to own
    // the counter and terminate it when the STAGING database was
    // complete, while the two renames that put it live happened
    // afterwards, outside any counter. A caller tailing the stream read
    // `finished` for a rebuild that was not yet the index anyone would
    // read - and if the rename then failed (ENOSPC, EPERM, a cross-device
    // `dbPath`) the command exited non-zero after a terminator that said
    // the run had finished.
    const watched = await runCli(args("reindex", "--progress"));
    expect(watched.returncode).toBe(0);
    const records = progressRecords(watched.stderr);

    const kinds = records.map((r) => String(r["kind"]));
    const stages = records.map((r) => String(r["stage"]));
    expect(kinds.at(-1)).toBe("finished");
    // Exactly one terminator, and the swap is on the near side of it.
    expect(kinds.filter((k) => k === "finished" || k === "stopped")).toHaveLength(1);
    // The swap is COUNTED before the run is terminated: an `advanced` on
    // the swap stage, then the terminator. (The terminator names `swap`
    // too, because it closes the stage that was open.)
    const swapDone = records.findIndex(
      (r) => r["stage"] === "swap" && r["kind"] === "advanced" && r["completed"] === 1,
    );
    expect(swapDone).toBeGreaterThanOrEqual(0);
    expect(swapDone).toBeLessThan(kinds.length - 1);

    // And the wait for the writer lock is no longer silent: it can be the
    // length of a competing rebuild, which is the state this release
    // calls indistinguishable from a hang.
    expect(stages[0]).toBe("lock");
  });
});
