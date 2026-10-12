/**
 * Surfacing-replay bench suite (t_107a3249, lane C Task 16).
 *
 * Replays a recorded prompt sequence through the shipped decision core
 * over the disposable fixture vault and scores every decision with the
 * SAME scorer the proactive-recall suite uses. The committed sample
 * contains a weak-match prompt the calibrated floor must stay quiet
 * about - its only term is hyphenated, so the keyword lane retrieves the
 * billing rows while the graded key reads zero substring coverage - and
 * a structural non-prompt no calibration should speak up for.
 *
 * Scope note (pr-250 review, M9): the harness drives the decision core
 * directly, so a structural prompt down here is judged on retrieval
 * alone - the suite calibrates the admission floor, it does not exercise
 * `evaluateSurfacingGate`'s short-circuits.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContinuityRecord } from "../../../src/core/brain/continuity/types.ts";
import { runMemoryBench } from "../../../src/core/bench/phases.ts";
import {
  parseReplayFixture,
  sessionTurnsToReplayFixture,
} from "../../../src/core/bench/replay-fixture.ts";
import { loadReplayBenchFixture, replayToBenchFixture } from "../../../src/core/bench/replay.ts";
import { benchSuite } from "../../../src/cli/brain/verbs/bench.ts";

function sessionTurn(overrides: Partial<ContinuityRecord> & { id: string }): ContinuityRecord {
  return {
    kind: "session_turn",
    createdAt: "2026-06-01T00:00:00.000Z",
    sourceRefs: [],
    payload: { role: "user", text: "a recorded prompt" },
    private: false,
    redacted: false,
    ...overrides,
  };
}

/** Same repo-relative convention as `locomo.test.ts`'s SAMPLE path. */
const SAMPLE = join("tests", "fixtures", "bench", "surfacing-replay-sample.json");

let runsDir: string;
let otherRunsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "o2b-bench-replay-"));
  otherRunsDir = mkdtempSync(join(tmpdir(), "o2b-bench-replay-b-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(otherRunsDir, { recursive: true, force: true });
});

test("the suite is registered with the bench verb and loads the committed sample", () => {
  const registration = benchSuite("surfacing-replay");
  expect(registration).toBeDefined();
  expect(registration?.capabilities.embeddings).toBe(false);
  // The registry loader returns the BenchSuiteLoad wrapper; the fixture
  // rides its `fixture` field.
  const fixture = registration?.loader(SAMPLE).fixture;
  expect(fixture?.name).toBe("surfacing-replay-sample");
  expect(fixture?.questions).toHaveLength(4);
  expect(fixture?.questions.every((q) => q.category === "proactive_recall")).toBe(true);
  const byId = new Map(fixture?.questions.map((q) => [q.id, q]));
  expect(byId.get("turn-1")?.expect_inject).toBe(true);
  expect(byId.get("turn-3")?.expect_inject).toBe(false);
  expect(byId.get("turn-3")?.prompt).toBe("billing-migration");
});

test("conversion round-trips the loader's shape through the canonical parser", () => {
  const replay = parseReplayFixture({
    name: "roundtrip",
    notes: [{ path: "notes/a.md", body: "Atlas launch checklist" }],
    turns: [
      { id: "a", text: "Who owns the billing migration?", expect: "inject" },
      { id: "b", text: "/help", expect: "abstain" },
    ],
  });
  const fixture = replayToBenchFixture(replay);
  expect(fixture.name).toBe("surfacing-replay-roundtrip");
  expect(fixture.notes).toHaveLength(1);
  expect(fixture.continuity).toHaveLength(0);
  expect(fixture.questions.map((q) => q.prompt)).toEqual([
    "Who owns the billing migration?",
    "/help",
  ]);
});

test("a committed replay fixture without notes converts through the CLI loader", () => {
  // The loader accepts an absent notes key ("Empty is valid": a session
  // of purely structural prompts has nothing to say about them), so the
  // conversion the registry hands runMemoryBench must accept it too -
  // questions only, no evidence notes.
  const path = join(runsDir, "notesless-replay.json");
  writeFileSync(
    path,
    JSON.stringify({
      name: "notesless",
      turns: [
        { id: "a", text: "Who owns the billing migration?", expect: "inject" },
        { id: "b", text: "/help", expect: "abstain" },
      ],
    }),
  );
  const fixture = loadReplayBenchFixture(path);
  expect(fixture.name).toBe("surfacing-replay-notesless");
  expect(fixture.notes).toHaveLength(0);
  expect(fixture.continuity).toHaveLength(0);
  expect(fixture.questions.map((q) => q.category)).toEqual([
    "proactive_recall",
    "proactive_recall",
  ]);
  expect(fixture.questions.map((q) => q.expect_inject)).toEqual([true, false]);
});

test("sessionTurnsToReplayFixture output (always notes-less) converts", () => {
  const replay = sessionTurnsToReplayFixture({
    name: "vault-lane",
    records: [
      sessionTurn({
        id: "t-1",
        payload: { role: "user", text: "Who owns the billing migration?" },
      }),
      sessionTurn({
        id: "t-2",
        createdAt: "2026-06-01T00:01:00.000Z",
        payload: { role: "user", text: "/help" },
      }),
    ],
    expectations: { "t-1": "inject", "t-2": "abstain" },
  });
  const fixture = replayToBenchFixture(replay);
  expect(fixture.name).toBe("surfacing-replay-vault-lane");
  expect(fixture.notes).toHaveLength(0);
  expect(fixture.questions.map((q) => q.prompt)).toEqual([
    "Who owns the billing migration?",
    "/help",
  ]);
});

test("a notes-less fixture runs end to end: an empty vault can only miss or abstain", async () => {
  const replay = parseReplayFixture({
    name: "notesless-e2e",
    turns: [
      { id: "a", text: "Who owns the billing migration?", expect: "inject" },
      { id: "b", text: "/help", expect: "abstain" },
    ],
  });
  const report = await runMemoryBench({ fixture: replayToBenchFixture(replay), runsDir });
  expect(report.quality.total).toBe(2);
  // Nothing in the vault, so nothing is injected: the abstain turn costs
  // zero and passes, the inject turn is an honest silent miss, and no
  // decision can false-fire.
  const byId = new Map(report.questions.map((q) => [q.id, q]));
  expect(byId.get("b")?.pass).toBe(true);
  expect(byId.get("b")?.injected_tokens).toBe(0);
  expect(byId.get("a")?.pass).toBe(false);
  expect(report.failure_modes.false_fire_rate).toBe(0);
  expect(report.failure_modes.know_to_ask_failure_rate).toBe(0.5);
}, 30_000);

test("the calibrated gate posts zero false fires; a permissive zero floor false-fires", async () => {
  const fixture = loadReplayBenchFixture(SAMPLE);
  // The shipped calibration (the hook floor, via the calculator).
  const calibrated = await runMemoryBench({ fixture, runsDir });
  expect(calibrated.failure_modes.false_fire_rate).toBe(0);
  expect(calibrated.failure_modes.know_to_ask_failure_rate).toBe(0);
  // The permissive arm: floor 0 admits every measurable weak match, so
  // the weak-match turn becomes a false fire. Separate runs dir: a fresh
  // run, not a resume of the calibrated one.
  const permissive = await runMemoryBench({ fixture, runsDir: otherRunsDir, recallFloor: 0 });
  expect(permissive.failure_modes.false_fire_rate).toBeGreaterThan(0);
  // Both arms share one denominator (four decisions), the anti-gaming term.
  expect(permissive.failure_modes.know_to_ask_failure_rate).toBe(0);
}, 60_000);

test("per-turn injected_tokens: an abstain injects nothing and costs zero", async () => {
  const fixture = loadReplayBenchFixture(SAMPLE);
  const calibrated = await runMemoryBench({ fixture, runsDir });
  const byId = new Map(calibrated.questions.map((q) => [q.id, q]));
  // A speaking turn reports its real cost.
  expect(byId.get("turn-1")?.injected_tokens ?? 0).toBeGreaterThan(0);
  expect(byId.get("turn-1")?.pass).toBe(true);
  // The weak-match abstain and the structural non-prompt cost exactly
  // zero - zero is the honest cost of nothing, not an absent measurement.
  expect(byId.get("turn-3")?.context_chars).toBe(0);
  expect(byId.get("turn-3")?.injected_tokens).toBe(0);
  expect(byId.get("turn-3")?.pass).toBe(true);
  expect(byId.get("turn-4")?.injected_tokens).toBe(0);
}, 60_000);

test("checkpoint and resume: a resumed run reports the same persisted decisions", async () => {
  const fixture = loadReplayBenchFixture(SAMPLE);
  const first = await runMemoryBench({ fixture, runsDir });
  const resumed = await runMemoryBench({ fixture, runsDir, resume: first.run_id });
  expect(resumed.run_id).toBe(first.run_id);
  expect(resumed.failure_modes).toEqual(first.failure_modes);
  expect(resumed.quality).toEqual(first.quality);
}, 60_000);
