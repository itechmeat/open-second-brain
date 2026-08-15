/**
 * `o2b brain maintenance run` under observation (nothing-runs-unwatched,
 * U1 + U3).
 *
 * The lane is a dispatcher over four long operations, not a fifth one, so
 * the property that matters here is different from the other verbs': the
 * stream carries the CHILDREN's events, and every record names the
 * operation that emitted it. That is what tells a reader which of the
 * four tasks the lane is currently inside - a counter over the lane's own
 * four steps would say "2 of 4" for twenty minutes and mean nothing.
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
let configPath: string;

const env = (): Record<string, string> => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

/**
 * The lane's own report, reduced to what an observer must not change:
 * the verdict, and each task's name and outcome. Durations are
 * wall-clock and are left out rather than asserted as stable.
 */
function laneReport(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as {
    verdict: string;
    tasks: Array<{ name: string; ok: boolean }>;
  };
  return {
    verdict: parsed.verdict,
    tasks: parsed.tasks.map((t) => `${t.name}:${String(t.ok)}`).toSorted(),
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-maint-progress-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  writeFileSync(join(vault, "one.md"), "# One\n\nLinks to [[two]].\n");
  writeFileSync(join(vault, "two.md"), "# Two\n\nLinks to [[one]].\n");
  const init = await runCli(["brain", "init", "--vault", vault], { env: env() });
  expect(init.returncode).toBe(0);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("o2b brain maintenance run --progress", () => {
  test("forwards each task's own stream, and leaves stdout untouched", async () => {
    const plain = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
      env: env(),
    });
    const watched = await runCli(
      ["brain", "maintenance", "run", "--vault", vault, "--json", "--progress"],
      { env: env() },
    );

    expect(plain.returncode).toBe(0);
    expect(watched.returncode).toBe(0);

    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    // The lane never speaks in its own name: every record on this stream
    // was emitted by the task doing the work, which is the whole of the
    // aggregator decision.
    expect(records.every((r) => r["operation"] !== OPERATION.maintenance)).toBe(true);
    const seen = new Set(records.map((r) => String(r["operation"])));
    expect(seen.has(OPERATION.dream)).toBe(true);
    expect(seen.has(OPERATION.reindex)).toBe(true);
    expect(progressRecords(plain.stderr)).toHaveLength(0);

    // The lane's own report is what stdout carries, unchanged: same
    // verdict, same four tasks, same success.
    expect(laneReport(watched.stdout)).toEqual(laneReport(plain.stdout));
  });

  test("integers and identifiers only - no prose on the structured stream", async () => {
    const watched = await runCli(["brain", "maintenance", "run", "--vault", vault, "--progress"], {
      env: env(),
    });
    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(String(record["stage"])).toMatch(STAGE_IDENTIFIER);
      expect(Number.isInteger(record["completed"])).toBe(true);
    }
  });

  test("without the flag nobody is watching, and the run is unchanged", async () => {
    const plain = await runCli(["brain", "maintenance", "run", "--vault", vault], { env: env() });
    expect(plain.returncode).toBe(0);
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });
});
