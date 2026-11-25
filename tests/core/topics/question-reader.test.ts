/**
 * The question state of a reader that asks again and again (a dream
 * session's server): `readTopicQuestionState` with the caller's reads
 * answers what a fresh read answers, after every change, and keeps the
 * part built from an unchanged planning read.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as foldModule from "../../../src/core/brain/dream-queue/fold.ts";
import { dreamWorkReads } from "../../../src/core/brain/dream-queue/operations.ts";
import * as queueModule from "../../../src/core/brain/dream-queue/queue.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  closedProduceSpec,
  closedQuestion,
  closedQuestions,
  readTopicQuestionState,
  type TopicQuestionState,
} from "../../../src/core/topics/decide-operations.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function asked(state: TopicQuestionState | null) {
  return closedQuestions(state!).map((q) => ({
    op: q.operation,
    subject: q.subject,
    input: q.input,
  }));
}

describe("readTopicQuestionState with kept reads", () => {
  test("answers what a fresh read answers after each change, and reuses an unchanged read", () => {
    const topic = f.seedTopic("Release work");
    const held = f.signal("Ship the release notes first", { session: "s1" });
    f.holdRecord(topic, held);
    f.signal("Ship the release notes first, always", { session: "s2" });
    const first = f.note("A first note");
    const reads = dreamWorkReads();

    const a = readTopicQuestionState(f.a, f.still(), reads);
    expect(asked(a)).toEqual(asked(readTopicQuestionState(f.a, f.still())));

    // Nothing new: the state built from the planning read is kept.
    const b = readTopicQuestionState(f.a, f.still(), reads);
    expect(b!.notes).toBe(a!.notes);
    expect(b!.candidates).toBe(a!.candidates);

    // A queue write (a question produced) is not a planning input; the
    // standing verdicts are still read afresh.
    const question = closedQuestions(b!).find((q) => q.subject === first)!;
    queueModule.produceWork(f.queue, closedProduceSpec(question));
    const c = readTopicQuestionState(f.a, f.still(), reads);
    expect(c!.notes).toBe(a!.notes);
    expect(asked(c)).toEqual(asked(readTopicQuestionState(f.a, f.still())));

    // A note judged and a new note: both seen at once.
    appendRecord(f.a, {
      partition: "shared",
      stream: "log",
      kind: "history-verdict",
      agent: "seed",
      body: { authority: "agent", record: first, keep: true },
    });
    const second = f.note("A second note");
    const d = readTopicQuestionState(f.a, f.still(), reads);
    expect(d!.notes).not.toBe(a!.notes);
    expect(d!.notes.map((n) => n.id)).toEqual([second]);
    expect(asked(d)).toEqual(asked(readTopicQuestionState(f.a, f.still())));
  });

  test("a read whose queue was unreadable keeps no state of an older read", () => {
    f.note("A first note");
    const reads = dreamWorkReads();
    readTopicQuestionState(f.a, f.still(), reads);
    // A new note arrives while a queue shard cannot be read: the read is
    // unavailable, and the next one, with the queue readable again, sees
    // the note although nothing was appended since.
    const second = f.note("A second note");
    const read = queueModule.readDreamWorkLater;
    const unreadable = spyOn(queueModule, "readDreamWorkLater").mockImplementation(
      (store, options) => {
        const result = read(store, options);
        return {
          unreadable: [...result.unreadable, "injected-unreadable-shard"],
          fold: result.fold,
        };
      },
    );
    try {
      expect(readTopicQuestionState(f.a, f.still(), reads)).toBeNull();
    } finally {
      unreadable.mockRestore();
    }
    const after = readTopicQuestionState(f.a, f.still(), reads);
    expect(after!.notes.map((n) => n.id)).toContain(second);
    expect(asked(after)).toEqual(asked(readTopicQuestionState(f.a, f.still())));
  });

  test("a history question's recheck through kept reads does not fold the queue", () => {
    const note = f.note("A note");
    const reads = dreamWorkReads();
    readTopicQuestionState(f.a, f.still(), reads);
    const folds = spyOn(foldModule, "foldDreamWork");
    try {
      const state = readTopicQuestionState(f.a, f.still(), reads)!;
      expect(closedQuestion(state, "human-readable", note)?.subject).toBe(note);
      expect(folds).not.toHaveBeenCalled();
      // A question that reads the plan folds it then, once.
      void state.plan;
      void state.standing;
      expect(folds).toHaveBeenCalledTimes(1);
    } finally {
      folds.mockRestore();
    }
  });
});
