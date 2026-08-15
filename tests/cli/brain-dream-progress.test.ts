/**
 * `o2b brain dream` under observation, and under a Ctrl-C.
 *
 * Two properties that only exist at the CLI boundary:
 *
 *   1. `--progress` writes newline-delimited records to STDERR while the
 *      pass runs, and stdout stays exactly what it was. A progress line
 *      on stdout would corrupt the payload `--json` callers parse, which
 *      is the whole reason the rail exists.
 *   2. The staged lifecycle carries the same stream: staging IS a dream
 *      pass, so `o2b brain dream stage --progress` reports the same five
 *      stages under the same operation name rather than nothing at all.
 *   3. This verb does NOT advertise a cooperative interrupt. `dreamRun`
 *      is synchronous end to end, so a signal handler cannot run while it
 *      does; Ctrl-C keeps its default meaning and kills the process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { EXIT_INTERRUPTED, interruptIsObservable } from "../../src/cli/interrupt.ts";
import { PROGRESS_KIND } from "../../src/core/brain/progress.ts";
import { OPERATION } from "../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";
import { progressRecords } from "../helpers/progress-records.ts";

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

  test("is observed once, not once per entry point", async () => {
    // The staged block and the inline pass each attach the rail, and
    // `run` falls THROUGH the staged block to the inline pass. A staged
    // attachment that did not exclude `run` would build two observers for
    // one pass, and the stream would carry every record twice.
    const watched = await runCli(["brain", "dream", "--dry-run", "--progress"], { env: env() });
    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    // One terminator for one run, and one `started` per distinct stage.
    expect(records.filter((r) => r["kind"] === PROGRESS_KIND.finished)).toHaveLength(1);
    const opened = records
      .filter((r) => r["kind"] === PROGRESS_KIND.started)
      .map((r) => r["stage"]);
    expect(opened).toEqual([...new Set(opened)]);
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

describe("o2b brain dream stage --progress", () => {
  test("watches the staged pass, which is a dream pass", async () => {
    // `DreamStageOptions.onProgress` was declared and threaded through
    // all three staged entry points with no caller able to ask: the verb
    // parsed `--progress` for `stage` and ignored it, so an operator
    // watching a staged pass saw nothing. This is the producer.
    const watched = await runCli(["brain", "dream", "stage", "--json", "--progress"], {
      env: env(),
    });
    expect(watched.returncode).toBe(0);

    const records = progressRecords(watched.stderr);
    expect(records.length).toBeGreaterThan(0);
    // Staging IS a dream call, so the records name `dream` rather than a
    // second operation reporting the same five stages under a new name.
    expect(records.every((r) => r["operation"] === OPERATION.dream)).toBe(true);
    expect(records[0]?.["kind"]).toBe(PROGRESS_KIND.started);
    expect(records.at(-1)?.["kind"]).toBe(PROGRESS_KIND.finished);
  });

  test("stdout is untouched, as it is for the inline pass", async () => {
    const plain = await runCli(["brain", "dream", "stage", "--json"], { env: env() });
    const watched = await runCli(["brain", "dream", "stage", "--json", "--progress"], {
      env: env(),
    });
    expect(plain.returncode).toBe(0);
    expect(watched.returncode).toBe(0);
    // Two runs of `stage` mint different run ids, so the comparison is of
    // the payload's SHAPE rather than its bytes - the run id is the one
    // field that is expected to differ.
    expect(Object.keys(JSON.parse(watched.stdout) as object).toSorted()).toEqual(
      Object.keys(JSON.parse(plain.stdout) as object).toSorted(),
    );
    expect(progressRecords(plain.stderr)).toHaveLength(0);
  });
});

describe("stopping a dream pass", () => {
  test("is not advertised as a cooperative interrupt, because it cannot be one", () => {
    // `dreamRun` is synchronous end to end, so a signal handler cannot
    // run while it does and `o2b brain dream` opens no handle. The
    // keystroke keeps its default meaning - it kills the process - which
    // is asserted where it belongs, in `interrupt-observability.test.ts`.
    // What is pinned here is that this verb is not claiming otherwise.
    expect(interruptIsObservable(OPERATION.dream)).toBe(false);
    // And that the code a verb WOULD return is still not a success code,
    // for the two verbs that can reach it.
    expect(EXIT_INTERRUPTED).toBe(130);
    expect(EXIT_INTERRUPTED).not.toBe(0);
  });
});
