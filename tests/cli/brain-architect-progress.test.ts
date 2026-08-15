/**
 * `o2b brain architect` under observation (nothing-runs-unwatched,
 * U1 + U3 + U11).
 *
 * The scan and the render already emit through the U1 sink and already
 * accept a deadline, and `OPERATION.architect` already resolves a budget
 * through the safeguard ladder - but the verb created no safeguard and
 * attached no rail, so `safeguard_timeout_architect_seconds` was a
 * configuration key nothing read. This is that key's consumer, and the
 * stream's.
 *
 * The abort arm is proved against the core rather than by racing a real
 * signal: the scan of this repository takes tens of milliseconds, so a
 * test that pressed Ctrl-C at the right moment would be a lottery.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateArchDocs } from "../../src/core/brain/architect/generate.ts";
import { createSafeguard, OPERATION, SafeguardAbortError } from "../../src/core/brain/safeguard.ts";
import { progressRecords, STAGE_IDENTIFIER } from "../helpers/progress-records.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let project: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-architect-progress-"));
  project = join(tmp, "demo-app");
  mkdirSync(join(project, "src", "core"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo-app" }));
  writeFileSync(join(project, "src", "core", "engine.ts"), "// x\n");
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("o2b brain architect --progress", () => {
  test("writes records to stderr and leaves stdout untouched", async () => {
    const plain = await runCli(["brain", "architect", project, "--vault", vault, "--json"]);
    // A second run over notes that already exist reports `unchanged`, so
    // the two payloads are compared across identical repeat runs.
    const warm = await runCli(["brain", "architect", project, "--vault", vault, "--json"]);
    const watched = await runCli([
      "brain",
      "architect",
      project,
      "--vault",
      vault,
      "--json",
      "--progress",
    ]);

    expect(plain.returncode).toBe(0);
    expect(watched.returncode).toBe(0);
    expect(watched.stdout).toBe(warm.stdout);

    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r["operation"] === OPERATION.architect)).toBe(true);
    expect(progressRecords(warm.stderr)).toHaveLength(0);
  });

  test("integers and identifiers only - no prose on the structured stream", async () => {
    const watched = await runCli(["brain", "architect", project, "--vault", vault, "--progress"]);
    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(String(record["stage"])).toMatch(STAGE_IDENTIFIER);
      expect(Number.isInteger(record["completed"])).toBe(true);
    }
  });

  test("without the flag nobody is watching, and the run is unchanged", async () => {
    const plain = await runCli(["brain", "architect", project, "--vault", vault]);
    expect(plain.returncode).toBe(0);
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });
});

describe("the safeguard the verb now builds", () => {
  test("a pre-aborted signal stops the pass before it writes", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      generateArchDocs(vault, project, {
        safeguard: createSafeguard({
          operation: OPERATION.architect,
          timeoutMs: null,
          signal: controller.signal,
        }),
      }),
    ).toThrow(SafeguardAbortError);
  });
});
