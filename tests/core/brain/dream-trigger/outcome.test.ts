/**
 * The outcome of a live pass (design D4, spec "A day is closed only by a
 * complete pass"): each outcome from a built pass result, the backoff
 * table up to its cap, and the day of a pass that crosses midnight.
 */
import { describe, expect, test } from "bun:test";

import {
  dayCompletion,
  decideDayOutcome,
  retryDelayMs,
  type QueueFacts,
  type ReplayFacts,
} from "../../../../src/core/brain/dream-trigger/outcome.ts";
import {
  emptyDreamTriggerRecord,
  type DreamTriggerRecord,
} from "../../../../src/core/brain/dream-trigger/record.ts";

const HOUR = 3_600_000;
const START = new Date("2026-11-20T09:00:00.000Z");
const END = new Date("2026-11-20T09:05:00.000Z");

const REPLAY_DONE: ReplayFacts = { unreadable: null, behind: [], open: null, gaps: [] };
const QUEUE_EMPTY: QueueFacts = {
  unreadable: [],
  privateUnknown: false,
  answerable: {},
  unanswerable: {},
};

function decide(
  replay: ReplayFacts,
  queue: QueueFacts,
  previous: DreamTriggerRecord = emptyDreamTriggerRecord("/r"),
  note: string | null = null,
): DreamTriggerRecord {
  const out = decideDayOutcome({
    previous,
    startedAt: START,
    endedAt: END,
    by: "worker",
    end: { kind: "returned", completion: dayCompletion(replay, queue), note },
  });
  if (out === null) throw new Error("no record");
  return out;
}

describe("what closes a day", () => {
  test("complete: nothing behind, no gap, no answerable work", () => {
    const r = decide(REPLAY_DONE, QUEUE_EMPTY, { ...emptyDreamTriggerRecord("/r"), failures: 2 });
    expect(r.closed).toBe(true);
    expect(r.day).toBe("2026-11-20");
    expect(r.failures).toBe(0);
    expect(r.retry_at).toBeNull();
    expect(r.reason).toBeNull();
    expect(r.last_run).toEqual({
      started_at: START.toISOString(),
      ended_at: END.toISOString(),
      outcome: "complete",
      by: "worker",
    });
  });

  test("a brain the replay and the queue do not serve closes", () => {
    expect(decide(null, null).closed).toBe(true);
  });

  test("complete with work nothing here answers: closed, with the note to show", () => {
    const queue = { ...QUEUE_EMPTY, unanswerable: { "rollup-summary": 2 } };
    const r = decide(REPLAY_DONE, queue, undefined, "Dream closed the day with work ...");
    expect(r.closed).toBe(true);
    expect(r.last_run?.outcome).toBe("complete-unanswerable");
    expect(r.note).toBe("Dream closed the day with work ...");
    expect(r.line).toEqual({ shown_day: null, text: "Dream closed the day with work ..." });
    expect(r.reason).toContain("nothing on this machine answers");
  });

  test("windows behind keep the day open with a retry time", () => {
    const r = decide({ ...REPLAY_DONE, behind: ["2026-11-18", "2026-11-19"] }, QUEUE_EMPTY);
    expect(r.closed).toBe(false);
    expect(r.failures).toBe(1);
    expect(r.retry_at).toBe(new Date(END.getTime() + HOUR).toISOString());
    expect(r.reason).toContain("2 window(s) behind (2026-11-18 to 2026-11-19)");
    expect(r.last_run?.outcome).toBe("incomplete");
  });

  test("an open window keeps the day open", () => {
    expect(decide({ ...REPLAY_DONE, open: "2026-11-20" }, QUEUE_EMPTY).closed).toBe(false);
  });

  test("a source with a gap keeps the day open", () => {
    const r = decide({ ...REPLAY_DONE, gaps: ["private/events-x"] }, QUEUE_EMPTY);
    expect(r.closed).toBe(false);
    expect(r.reason).toContain("private/events-x");
  });

  test("answerable work left keeps the day open", () => {
    const r = decide(REPLAY_DONE, { ...QUEUE_EMPTY, answerable: { "topic-merge": 3 } });
    expect(r.closed).toBe(false);
    expect(r.reason).toContain("3 ready work item(s) this machine answers");
  });

  test("an incomplete read is not a complete day", () => {
    expect(decide({ unreadable: "shared/dream-replay/x" }, QUEUE_EMPTY).closed).toBe(false);
    expect(decide(REPLAY_DONE, { ...QUEUE_EMPTY, unreadable: ["shared/x"] }).closed).toBe(false);
    expect(decide(REPLAY_DONE, { ...QUEUE_EMPTY, privateUnknown: true }).closed).toBe(false);
  });

  test("a throw keeps the day open and names the failure", () => {
    const r = decideDayOutcome({
      previous: emptyDreamTriggerRecord("/r"),
      startedAt: START,
      endedAt: END,
      by: "cli",
      end: { kind: "threw", message: "dream exceeded its deadline" },
    });
    expect(r?.closed).toBe(false);
    expect(r?.last_run?.outcome).toBe("failed");
    expect(r?.reason).toBe("the pass failed: dream exceeded its deadline");
    expect(r?.failures).toBe(1);
  });

  test("the failure count is carried from the record", () => {
    const previous = { ...emptyDreamTriggerRecord("/r"), failures: 2 };
    const r = decide({ ...REPLAY_DONE, open: "2026-11-20" }, QUEUE_EMPTY, previous);
    // Three in a row: four hours after the third.
    expect(r.failures).toBe(3);
    expect(r.retry_at).toBe(new Date(END.getTime() + 4 * HOUR).toISOString());
  });
});

describe("the backoff", () => {
  test("one hour after the first failure, doubling, at most one day", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => retryDelayMs(n) / HOUR)).toEqual([
      1, 2, 4, 8, 16, 24, 24, 24,
    ]);
  });
});

describe("the day of a pass", () => {
  test("a pass that crosses midnight closes the day it started in", () => {
    const out = decideDayOutcome({
      previous: emptyDreamTriggerRecord("/r"),
      startedAt: new Date("2026-11-20T23:58:00.000Z"),
      endedAt: new Date("2026-11-21T00:03:00.000Z"),
      by: "worker",
      end: { kind: "returned", completion: dayCompletion(REPLAY_DONE, QUEUE_EMPTY), note: null },
    });
    expect(out?.day).toBe("2026-11-20");
    expect(out?.closed).toBe(true);
  });

  test("a pass of an earlier day than the record's leaves that day and records the attempt", () => {
    const previous = { ...emptyDreamTriggerRecord("/r"), day: "2026-11-21", closed: true };
    const out = decideDayOutcome({
      previous,
      startedAt: START,
      endedAt: END,
      by: "worker",
      end: { kind: "threw", message: "x" },
    });
    expect(out).toMatchObject({ day: "2026-11-21", closed: true, failures: 0 });
    expect(out?.last_run).toMatchObject({ outcome: "failed", started_at: START.toISOString() });
    expect(out?.retry_at).toBe(new Date(END.getTime() + HOUR).toISOString());
  });
});
