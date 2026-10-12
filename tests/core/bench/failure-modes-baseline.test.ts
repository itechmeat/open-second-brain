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

import { fixtureHash, loadBenchFixture } from "../../../src/core/bench/fixture.ts";
import { runMemoryBench } from "../../../src/core/bench/phases.ts";
import { loadReplayBenchFixture } from "../../../src/core/bench/replay.ts";
import type { BenchReport } from "../../../src/core/bench/types.ts";

const FIXTURE_DIR = join("tests", "fixtures", "bench");
const FIXTURE_PATH = join(FIXTURE_DIR, "failure-modes.json");
const BASELINE_PATH = join(FIXTURE_DIR, "failure-modes.baseline.json");
const FAILURE_MODES_SOURCE = join("src", "core", "bench", "failure-modes.ts");

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
    expect(baseline.schema).toBe("o2b.bench.v2");
    // Hash-shaped is not enough: the committed hash must be the CURRENT
    // fixture's, so an edited-but-never-re-measured fixture names itself
    // here instead of failing somewhere confusing downstream.
    expect(baseline.fixture_hash).toBe(fixtureHash(loadBenchFixture(FIXTURE_PATH)));
  });

  test("the graded gate is scoreable: the replay corpus bounds its false-fire rate", async () => {
    // The structural half of the gate fails open by design; the graded
    // admission key is the bound, and the replay corpus is its measurement
    // instrument. Three assertions make the bound MEANINGFUL rather than
    // vacuous: the calibrated gate speaks on the corpus at all (an
    // always-abstain gate would also post zero false fires), it never
    // false-fires on it, and the same corpus catches a permissive gate -
    // the floor 0 arm shows the corpus can tell an always-inject strategy
    // apart, so the calibrated zero is a measured bound, not silence.
    const fixture = loadReplayBenchFixture(join(FIXTURE_DIR, "surfacing-replay-sample.json"));
    const calibrated = await runMemoryBench({ fixture, runsDir });
    expect(calibrated.context_cost.avg_injected_tokens).toBeGreaterThan(0);
    expect(calibrated.failure_modes.false_fire_rate).toBe(0);
    const permissive = await runMemoryBench({
      fixture,
      runsDir: join(runsDir, "permissive"),
      recallFloor: 0,
    });
    expect(permissive.failure_modes.false_fire_rate).toBeGreaterThan(0);
  }, 60_000);

  test("the failure-modes docblock describes the graded gate, not an unscoreable one", () => {
    // The retired claim - that the gate's false-fire rate is ~1 by
    // construction and scoring it would be theatre - described the
    // structural predicate alone. Admission now rides the graded surfacing
    // key, and the replay suite measures it; the docblock that understates
    // what ships invites the next reader to re-derive the caveat.
    const source = readFileSync(FAILURE_MODES_SOURCE, "utf8");
    expect(source).not.toContain("would be theatre");
    expect(source).not.toContain("NOT THE GATE");
    // It names the instrument that replaced the caveat.
    expect(source).toMatch(/surfacing-replay/);
  });
});
