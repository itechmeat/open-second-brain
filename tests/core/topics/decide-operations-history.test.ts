/**
 * The `human-readable` operation (change `dream-closed-questions`,
 * design D3, task 2.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dreamWorkOperation } from "../../../src/core/brain/dream-queue/operations.ts";
import { produceWork } from "../../../src/core/brain/dream-queue/queue.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  closedProduceSpec,
  closedQuestion,
  closedQuestions,
  readTopicQuestionState,
} from "../../../src/core/topics/decide-operations.ts";
import { closedFixture, T0, type ClosedFixture } from "./fixtures/closed-fixture.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function asked() {
  return closedQuestions(readTopicQuestionState(f.a, f.still())!).filter(
    (q) => q.operation === "human-readable",
  );
}

describe("human-readable", () => {
  test("every unjudged shared note is asked about, however old", () => {
    const old = f.note("A note from three months ago", T0 - 90 * 24 * 3600_000);
    const fresh = f.note("A note from today");
    expect(
      asked()
        .map((q) => q.subject)
        .toSorted(),
    ).toEqual([old, fresh].toSorted());
  });

  test("a note with a private region and a judged note are not asked about", () => {
    f.note("Keep <private>secret</private> out");
    const judged = f.note("Already judged");
    appendRecord(f.a, {
      partition: "shared",
      stream: "log",
      kind: "history-verdict",
      agent: "seed",
      body: { authority: "agent", record: judged, keep: true },
    });
    expect(asked()).toEqual([]);
  });

  test("validate, and an input that is gone once the note is judged", () => {
    const note = f.note("A note worth keeping");
    const question = closedQuestion(
      readTopicQuestionState(f.a, f.still())!,
      "human-readable",
      note,
    )!;
    expect(question.private).toBe(false);
    const { id } = produceWork(f.queue, closedProduceSpec(question));
    const item = f.items("human-readable").find((i) => i.id === id)!;
    const op = dreamWorkOperation("human-readable")!;
    expect(op.validate({ value: { provider: "p", model: "m", p: 0.1 } }, item)).toBeNull();
    expect(op.currentInput(item, { store: f.a, vault: null, now: f.still() })?.input_hash).toBe(
      item.body.input_hash,
    );
    appendRecord(f.a, {
      partition: "shared",
      stream: "log",
      kind: "history-verdict",
      agent: "seed",
      body: { authority: "agent", record: note, keep: false },
    });
    expect(op.currentInput(item, { store: f.a, vault: null, now: f.still() })).toBeNull();
  });
});
