/**
 * `o2b brain dream` under observation, and under a Ctrl-C.
 *
 * Two properties that only exist at the CLI boundary:
 *
 *   1. `--progress` writes newline-delimited records to STDERR while the
 *      pass runs, and stdout stays exactly what it was. A progress line
 *      on stdout would corrupt the payload `--json` callers parse, which
 *      is the whole reason the rail exists.
 *   2. An interrupted pass exits with the shell's signal convention
 *      rather than 0. `o2b search watch` exits 0 when interrupted because
 *      stopping is how that command ends; a consolidation pass stopped
 *      half-way did not do what it was asked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { EXIT_INTERRUPTED } from "../../src/cli/interrupt.ts";
import { PROGRESS_KIND, PROGRESS_SCHEMA } from "../../src/core/brain/progress.ts";
import { OPERATION } from "../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-dream-progress-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-cli-dream-progress-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  for (const [i, date] of ["2026-05-20", "2026-05-21", "2026-05-22"].entries()) {
    writeSignal(vault, {
      topic: "cli-progress",
      signal: "positive",
      agent: "claude",
      principle: "Prefer the cli-progress approach",
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `cli-progress-${i}`,
      scope: "writing",
    });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const env = (): Record<string, string> => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

/** Every progress record on a stderr stream, in order. */
function progressRecords(stderr: string): ReadonlyArray<Record<string, unknown>> {
  const out: Record<string, unknown>[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.startsWith("{")) continue;
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === PROGRESS_SCHEMA
    ) {
      out.push(parsed as Record<string, unknown>);
    }
  }
  return out;
}

describe("o2b brain dream --progress", () => {
  test("writes records to stderr and leaves stdout untouched", async () => {
    const plain = await runCli(["brain", "dream", "--dry-run", "--json"], { env: env() });
    const watched = await runCli(["brain", "dream", "--dry-run", "--json", "--progress"], {
      env: env(),
    });

    expect(plain.returncode).toBe(0);
    expect(watched.returncode).toBe(0);
    // The payload a caller parses is byte-identical with and without the
    // observer. Progress that changed stdout would be a regression, not a
    // feature.
    expect(watched.stdout).toBe(plain.stdout);

    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r["operation"] === OPERATION.dream)).toBe(true);
    expect(records[0]?.["kind"]).toBe(PROGRESS_KIND.started);
    expect(records.at(-1)?.["kind"]).toBe(PROGRESS_KIND.finished);
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });

  test("integers and identifiers only - no prose on the structured stream", async () => {
    const watched = await runCli(["brain", "dream", "--dry-run", "--progress"], { env: env() });
    for (const record of progressRecords(watched.stderr)) {
      expect(typeof record["stage"]).toBe("string");
      // An identifier, never a sentence: the human line is rendered from
      // this at the edge, which is the rule that keeps the advisory rail
      // free of caller-supplied prose too.
      expect(String(record["stage"])).toMatch(/^[a-z0-9]+([-_][a-z0-9]+)*$/);
      expect(Number.isInteger(record["completed"])).toBe(true);
    }
  });
});

describe("the interrupted exit code", () => {
  test("is the shell's signal convention, not success", () => {
    // Pinned as a constant rather than asserted through a real signal: a
    // test that races a SIGINT against a sub-second pass would be a
    // machine-speed lottery, which is the defect class this project has
    // fixed twice. The reachability of the abort path is proved in the
    // core test that drives a pre-aborted signal.
    expect(EXIT_INTERRUPTED).toBe(130);
    expect(EXIT_INTERRUPTED).not.toBe(0);
  });
});
