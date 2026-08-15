/**
 * The committed baseline for the four-failure-mode suite (t_72d6eb23).
 *
 * ## Why this is a test and not a CI step
 *
 * Before this file, NO baseline was committed anywhere in the repo: both
 * things called "baselines" were constants inside test files, and CI ran
 * no bench at all - `.github/workflows/ci.yml` runs `bun test` and that is
 * the entire gate. So there were two ways to make the numbers gate:
 *
 *   1. A new workflow step invoking `o2b brain bench memory`.
 *   2. A test inside the run that already gates every push.
 *
 * This is (2), deliberately. A separate CI step is a surface a developer
 * never sees until it goes red in a pull request, cannot run the same way
 * locally, and needs its own artifact plumbing to say WHICH number moved.
 * A test runs identically on a laptop and in CI, fails the build the same
 * way every other regression does, and prints the diff for free. A gate
 * nobody looks at is worse than a gate that fails the build. Cost is not
 * the reason - the whole suite runs in a few seconds offline, with the
 * semantic lane pinned off inside the harness.
 *
 * ## Re-measurement protocol
 *
 * The baseline is EXPECTED to move when the fixture or the shipped code
 * legitimately changes. It is not a number to nudge until the test passes.
 * When this fails:
 *
 *   1. Read WHICH field moved. A `fixture_hash` mismatch alone means the
 *      fixture changed and the numbers were never re-measured.
 *   2. Decide whether the move is an improvement, a regression, or a
 *      change in what is being measured. Say which in the commit message.
 *   3. Only then regenerate `failure-modes.baseline.json` from a green
 *      run and commit it WITH the change that moved it, never separately.
 *
 * Latency is deliberately absent from the baseline: it is the one figure
 * that legitimately differs between a laptop and a CI runner, and pinning
 * it would make the gate flaky in exchange for nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBenchFixture } from "../../../src/core/bench/fixture.ts";
import { runMemoryBench } from "../../../src/core/bench/phases.ts";
import type { BenchReport } from "../../../src/core/bench/types.ts";

const FIXTURE_DIR = join("tests", "fixtures", "bench");
const FIXTURE_PATH = join(FIXTURE_DIR, "failure-modes.json");
const BASELINE_PATH = join(FIXTURE_DIR, "failure-modes.baseline.json");

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "o2b-bench-baseline-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

/** The reproducible slice of a report: everything but the clock. */
function comparable(report: BenchReport): Record<string, unknown> {
  return {
    schema: report.schema,
    fixture: report.fixture,
    fixture_hash: report.fixture_hash,
    quality: report.quality,
    context_cost: report.context_cost,
    failure_modes: report.failure_modes,
    questions: report.questions.map((question) => ({
      id: question.id,
      category: question.category,
      pass: question.pass,
      ...(question.context_chars !== undefined ? { context_chars: question.context_chars } : {}),
      ...(question.injected_tokens !== undefined
        ? { injected_tokens: question.injected_tokens }
        : {}),
    })),
  };
}

describe("failure-mode baseline", () => {
  test("the committed report still describes what the code does", async () => {
    const report = await runMemoryBench({ fixture: loadBenchFixture(FIXTURE_PATH), runsDir });
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>;
    expect(comparable(report)).toEqual(baseline);
  }, 60_000);

  test("the baseline is pinned to the fixture that produced it", () => {
    // Without this, editing the fixture and forgetting to re-measure would
    // fail somewhere confusing instead of saying what happened.
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
      fixture_hash: string;
      schema: string;
    };
    expect(baseline.fixture_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(baseline.schema).toBe("o2b.bench.v2");
  });
});
