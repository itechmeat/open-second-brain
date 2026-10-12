/**
 * Replay fixture loader (t_107a3249, lane C Task 15).
 *
 * The loader is PURE and deterministic: a committed session-shaped JSON
 * becomes an ordered prompt sequence with expected surfacing outcomes,
 * and a vault's own `session_turn` records convert into the same shape.
 * The expected-outcome vocabulary is closed; anything else is a named
 * rejection, never a silent default expectation.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import type { ContinuityRecord } from "../../../src/core/brain/continuity/types.ts";
import {
  loadReplayFixture,
  parseReplayFixture,
  REPLAY_EXPECTATIONS,
  REPLAY_EXPECTATION,
  sessionTurnsToReplayFixture,
  ReplayFixtureError,
} from "../../../src/core/bench/replay-fixture.ts";

/** Same repo-relative convention as `locomo.test.ts`'s SAMPLE path. */
const SAMPLE_PATH = join("tests", "fixtures", "bench", "surfacing-replay-sample.json");

function sessionTurn(overrides: Partial<ContinuityRecord> & { id: string }): ContinuityRecord {
  return {
    kind: "session_turn",
    createdAt: "2026-06-01T00:00:00.000Z",
    sourceRefs: [],
    payload: { text: "a recorded prompt" },
    private: false,
    redacted: false,
    ...overrides,
  };
}

test("the committed sample loads into an ordered prompt sequence with expectations", () => {
  const fixture = loadReplayFixture(SAMPLE_PATH);
  expect(fixture.name).toBe("surfacing-replay-sample");
  expect(fixture.prompts.map((p) => p.id)).toEqual(["turn-1", "turn-2", "turn-3", "turn-4"]);
  expect(fixture.prompts.map((p) => p.expectInject)).toEqual([true, true, false, false]);
  // Order is the session's order, and each prompt carries the text of the
  // one before it, which is what duplicate detection reads.
  expect(fixture.prompts[0]!.previousText).toBeNull();
  expect(fixture.prompts[1]!.previousText).toBe("Who owns the billing migration?");
  expect(fixture.prompts[2]!.text).toBe("Priya asked about the office lease renewal timeline");
});

test("the loader is deterministic: the same file parses to an equal fixture twice", () => {
  expect(loadReplayFixture(SAMPLE_PATH)).toEqual(loadReplayFixture(SAMPLE_PATH));
});

test("parse keeps declared order and maps the closed expectation vocabulary", () => {
  const fixture = parseReplayFixture({
    name: "tiny",
    notes: [{ path: "notes/a.md", body: "Atlas launch checklist" }],
    turns: [
      { id: "a", text: "Who owns the billing migration?", expect: "inject" },
      { id: "b", text: "/help", expect: "abstain" },
    ],
  });
  expect(fixture.prompts).toHaveLength(2);
  expect(fixture.prompts[0]).toEqual({
    id: "a",
    text: "Who owns the billing migration?",
    previousText: null,
    expectInject: true,
  });
  expect(fixture.prompts[1]!.previousText).toBe("Who owns the billing migration?");
});

test("an unknown expectation is a named rejection carrying the turn id and value", () => {
  expect(() =>
    parseReplayFixture({
      name: "tiny",
      notes: [],
      turns: [{ id: "a", text: "hello", expect: "maybe" }],
    }),
  ).toThrow(ReplayFixtureError);
  expect(() =>
    parseReplayFixture({
      name: "tiny",
      notes: [],
      turns: [{ id: "a", text: "hello", expect: "maybe" }],
    }),
  ).toThrow(/turn 'a'.*'maybe'/);
});

test("a turn missing an expectation is rejected, never defaulted", () => {
  expect(() =>
    parseReplayFixture({ name: "tiny", notes: [], turns: [{ id: "a", text: "hello" }] }),
  ).toThrow(/turn 'a'.*expect/);
});

test("duplicate turn ids are rejected", () => {
  expect(() =>
    parseReplayFixture({
      name: "tiny",
      notes: [],
      turns: [
        { id: "a", text: "one", expect: "inject" },
        { id: "a", text: "two", expect: "abstain" },
      ],
    }),
  ).toThrow(/duplicate turn id 'a'/);
});

test("a fixture needs a name and at least one turn; notes may be empty", () => {
  expect(() =>
    parseReplayFixture({ name: "", notes: [], turns: [{ id: "a", text: "x", expect: "inject" }] }),
  ).toThrow(/name/);
  expect(() => parseReplayFixture({ name: "tiny", notes: [], turns: [] })).toThrow(/turns/);
  expect(
    parseReplayFixture({
      name: "tiny",
      notes: [],
      turns: [{ id: "a", text: "x", expect: "abstain" }],
    }).prompts,
  ).toHaveLength(1);
});

test("the expectation vocabulary is closed and exported for consumers", () => {
  expect(REPLAY_EXPECTATIONS).toEqual([REPLAY_EXPECTATION.inject, REPLAY_EXPECTATION.abstain]);
});

test("session_turn records convert into the same fixture shape, chronologically", () => {
  // Deliberately out of chronological order in, chronological order out.
  const records = [
    sessionTurn({
      id: "r2",
      createdAt: "2026-06-02T00:00:00.000Z",
      payload: { text: "second prompt" },
    }),
    sessionTurn({
      id: "r1",
      createdAt: "2026-06-01T00:00:00.000Z",
      payload: { text: "first prompt" },
    }),
  ];
  const fixture = sessionTurnsToReplayFixture({
    name: "from-vault",
    records,
    expectations: { r1: "inject", r2: "abstain" },
  });
  expect(fixture.name).toBe("surfacing-replay-from-vault");
  expect(fixture.prompts.map((p) => [p.id, p.text, p.expectInject])).toEqual([
    ["r1", "first prompt", true],
    ["r2", "second prompt", false],
  ]);
  expect(fixture.prompts[1]!.previousText).toBe("first prompt");
});

test("a session_turn record without text, of the wrong kind, without an expectation, or with an unknown expectation is rejected by name", () => {
  const base = [sessionTurn({ id: "r1" })];
  expect(() => sessionTurnsToReplayFixture({ name: "x", records: base, expectations: {} })).toThrow(
    /turn 'r1'.*expect/,
  );
  expect(() =>
    sessionTurnsToReplayFixture({
      name: "x",
      records: base,
      expectations: { r1: "sometimes" },
    }),
  ).toThrow(/turn 'r1'.*'sometimes'/);
  expect(() =>
    sessionTurnsToReplayFixture({
      name: "x",
      records: [sessionTurn({ id: "r1", payload: {} })],
      expectations: { r1: "inject" },
    }),
  ).toThrow(/turn 'r1'.*text/);
  expect(() =>
    sessionTurnsToReplayFixture({
      name: "x",
      records: [sessionTurn({ id: "r1", kind: "negative_recall" })],
      expectations: { r1: "inject" },
    }),
  ).toThrow(/session_turn/);
});

test("conversion is deterministic across repeated calls", () => {
  const records = [sessionTurn({ id: "r1", payload: { text: "same" } })];
  const expectations = { r1: "inject" } as const;
  expect(sessionTurnsToReplayFixture({ name: "x", records, expectations })).toEqual(
    sessionTurnsToReplayFixture({ name: "x", records, expectations }),
  );
});

test("the expectation constants agree with the boolean they load into", () => {
  const fixture = parseReplayFixture({
    name: "tiny",
    notes: [],
    turns: [
      { id: "a", text: "x", expect: REPLAY_EXPECTATION.inject },
      { id: "b", text: "y", expect: REPLAY_EXPECTATION.abstain },
    ],
  });
  expect(fixture.prompts.map((p) => p.expectInject)).toEqual([true, false]);
});
