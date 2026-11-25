/**
 * The planning read through kept tails (`catchUpWhereKept`): what a dream
 * session's server rereads on every take and answer. It answers what the
 * full read (`catchUpWhere`) answers for the same store, and says whether
 * the kept records changed, so a caller keeps what it built from them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { produceWork } from "../../../src/core/brain/dream-queue/queue.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readClock } from "../../../src/core/store/clock-store.ts";
import { compareHlc, parseHlc } from "../../../src/core/store/hlc.ts";
import { isTopicPlanningInput } from "../../../src/core/topics/candidates.ts";
import {
  catchUpWhere,
  catchUpWhereKept,
  type CatchUpTails,
  type ViewCatchUp,
} from "../../../src/core/view/catch-up.ts";
import { closedFixture, type ClosedFixture } from "../topics/fixtures/closed-fixture.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function ids(read: ViewCatchUp): Record<string, string[]> {
  return Object.fromEntries([...read.records].map(([p, records]) => [p, records.map((r) => r.id)]));
}

function queueWrite(subject: string): void {
  produceWork(f.queue, {
    operation: "human-readable",
    subject,
    occurrence: `2026-12-01/${subject}`,
    input: { text: subject },
    prompt_version: "1",
    schema_version: "1",
    answer_schema: { type: "probability" },
    after: [],
    resources: [],
    evidence: [subject],
    payload: { text: subject },
    sources: ["shared"],
  });
}

describe("catchUpWhereKept", () => {
  test("answers what the full read answers, and is fresh only when the kept records change", () => {
    f.note("first note");
    f.signal("a first rule");
    const tails: CatchUpTails = new Map();
    const first = catchUpWhereKept(f.a, isTopicPlanningInput, tails);
    expect(first.fresh).toBe(true);
    expect(ids(first.read)).toEqual(ids(catchUpWhere(f.a, isTopicPlanningInput)));
    expect(first.read.unreadable).toEqual([]);

    const again = catchUpWhereKept(f.a, isTopicPlanningInput, tails);
    expect(again.fresh).toBe(false);
    expect(ids(again.read)).toEqual(ids(first.read));
    // Given the previous read, an unchanged reread answers it as it is.
    const same = catchUpWhereKept(f.a, isTopicPlanningInput, tails, undefined, again.read);
    expect(same.read).toBe(again.read);

    // The queue's own writes are records planning does not keep.
    queueWrite("s1");
    const afterQueue = catchUpWhereKept(f.a, isTopicPlanningInput, tails);
    expect(afterQueue.fresh).toBe(false);
    expect(ids(afterQueue.read)).toEqual(ids(catchUpWhere(f.a, isTopicPlanningInput)));

    const second = f.note("second note");
    const afterNote = catchUpWhereKept(f.a, isTopicPlanningInput, tails);
    expect(afterNote.fresh).toBe(true);
    expect(afterNote.read.records.get("shared")!.map((r) => r.id)).toContain(second);
    expect(ids(afterNote.read)).toEqual(ids(catchUpWhere(f.a, isTopicPlanningInput)));
  });

  test("a record another process appended is read, and raises the clock past it", () => {
    const tails: CatchUpTails = new Map();
    f.note("first note");
    catchUpWhereKept(f.a, isTopicPlanningInput, tails);
    // Another writer stamps far ahead of this device's saved clock.
    const ahead = Date.now() + 60_000;
    const record = appendRecord(
      f.a,
      {
        partition: "shared",
        stream: "log",
        kind: "log-event",
        agent: "elsewhere",
        body: {
          timestamp: new Date(ahead).toISOString(),
          event_type: "note",
          body: { text: "a note from the future" },
        },
      },
      { now: () => ahead },
    ).record;
    const read = catchUpWhereKept(f.a, isTopicPlanningInput, tails);
    expect(read.fresh).toBe(true);
    expect(read.read.records.get("shared")!.map((r) => r.id)).toContain(record.id);
    const clock = readClock(f.a.deviceStateDir, f.a.device)!;
    expect(compareHlc(clock, parseHlc(record.hlc)!)).toBeGreaterThanOrEqual(0);
  });
});
