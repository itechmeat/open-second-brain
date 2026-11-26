/**
 * Asking a waiting question again (the night of 2026-11-26 on a real
 * brain): every new or reworded topic changed the input of every waiting
 * routing question. The producer queued a second item per record each
 * time, the take folded the whole queue again for every stale item it
 * passed, and each recheck built the topic plan afresh. A subject is now
 * asked once at a time, a take folds once per round, and a session's
 * reader keeps the plan while nothing it is built from changes.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as foldModule from "../../../src/core/brain/dream-queue/fold.ts";
import { dreamWorkReads } from "../../../src/core/brain/dream-queue/operations.ts";
import {
  produceWork,
  takeWorkBatch,
  type DreamQueue,
} from "../../../src/core/brain/dream-queue/queue.ts";
import {
  closedProduceSpec,
  closedQuestion,
  readTopicQuestionState,
} from "../../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../../src/core/topics/decide-produce.ts";
import * as candidatesModule from "../../../src/core/topics/candidates.ts";
import * as planModule from "../../../src/core/topics/plan.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function produce() {
  const state = readTopicQuestionState(f.a, f.still())!;
  return produceTopicQuestions(f.queue, state, {
    until: Number.POSITIVE_INFINITY,
    clock: f.still,
  });
}

/** The queue as a dream session's server holds it: with the reads it keeps between calls. */
function session(): DreamQueue {
  return { ...f.queue, reads: dreamWorkReads() };
}

const routes = {
  filter: (item: { body: { operation: string } }) => item.body.operation === "topic-route",
};

function topicsOf(item: { body: { payload: Record<string, unknown> } }): string[] {
  return (item.body.payload["topics"] as Array<{ title: string }>).map((t) => t.title).toSorted();
}

describe("a waiting question whose input changed", () => {
  test("is not queued again while its item is open; the take asks it with the input of then", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    produce();
    expect(f.items("topic-route").map((i) => i.body.subject)).toEqual([record]);

    // A second topic that fits the record: the question's input changes.
    f.seedTopic("Shard compaction window settings");
    const again = produce();
    expect(again.asked["topic-route"]).toBe(0);
    const queued = f.items("topic-route");
    expect(queued).toHaveLength(1);
    expect(topicsOf(queued[0]!)).toHaveLength(1);

    // The take rechecks the open item: it closes it and leases its
    // successor, which carries both topics.
    const got = takeWorkBatch(session(), { run: "churn", max: 1, ...routes });
    expect(got.items).toHaveLength(1);
    expect(got.items[0]!.subject).toBe(record);
    expect(
      (got.items[0]!.payload["topics"] as Array<{ title: string }>).map((t) => t.title).toSorted(),
    ).toEqual([
      "Shard compaction keeps monthly shard files small",
      "Shard compaction window settings",
    ]);
    const after = f.items("topic-route");
    expect(after.filter((i) => i.state === "closed")).toHaveLength(1);
    expect(after.filter((i) => i.state === "leased")).toHaveLength(1);
  });

  test("a take that passes many stale items folds the queue once per round, not once per item", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const records = Array.from({ length: 12 }, (_, i) =>
      f.signal(`Shard compaction thresholds were tuned on run ${i}`),
    );
    produce();
    expect(f.items("topic-route")).toHaveLength(records.length);
    f.seedTopic("Shard compaction window settings");

    const queue = session();
    const folds = spyOn(foldModule, "foldDreamWork");
    try {
      const got = takeWorkBatch(queue, { run: "churn", max: records.length, ...routes });
      expect(got.items).toHaveLength(records.length);
      // The entry's fold, one more after the round that closed the stale
      // items, the confirmation after the leases and the entry's own
      // confirmation: a handful, whatever the number of stale items.
      expect(folds.mock.calls.length).toBeLessThanOrEqual(5);
    } finally {
      folds.mockRestore();
    }
    const after = f.items("topic-route");
    expect(after.filter((i) => i.state === "closed")).toHaveLength(records.length);
    expect(after.filter((i) => i.state === "leased")).toHaveLength(records.length);
  });

  test("the questions an older build asked again are closed by the next pass, the newest kept", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    const question = closedQuestion(
      readTopicQuestionState(f.a, f.still())!,
      "topic-route",
      record,
    )!;
    // What an older build left: three open items about the record, each
    // for an input of its day.
    const spec = closedProduceSpec(question);
    for (const day of [1, 2, 3]) {
      const input = { ...(spec.input as Record<string, unknown>), day };
      produceWork(f.queue, { ...spec, input, payload: input });
    }
    expect(f.items("topic-route").filter((i) => i.state === "waiting")).toHaveLength(3);

    const result = produce();
    expect(result.duplicates).toBe(2);
    const items = f.items("topic-route");
    const open = items.filter((i) => i.state === "waiting");
    expect(open).toHaveLength(1);
    expect(open[0]!.body.payload["day"]).toBe(3);
    const closed = items.filter((i) => i.state === "closed");
    expect(closed.map((i) => i.closed)).toEqual([
      { reason: "superseded", note: "asked again", successor: open[0]!.id },
      { reason: "superseded", note: "asked again", successor: open[0]!.id },
    ]);
    // Nothing more to close, and the question is not asked again.
    expect(produce().duplicates).toBe(0);
    expect(f.items("topic-route")).toHaveLength(3);
  });

  test("a session's reader builds the topic plan once while nothing it is built from changes", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.signal("Shard compaction thresholds were tuned today");
    f.signal("Shard compaction thresholds were tuned again");
    produce();
    const queue = session();
    const reads = queue.reads!;
    const plans = spyOn(planModule, "planTopics");
    try {
      // Every take and answer of a session rechecks its item through the
      // same reads: the leases written between them change nothing the
      // plan is built from.
      void readTopicQuestionState(f.a, f.still(), reads)!.plan;
      takeWorkBatch(queue, { run: "churn", max: 1, ...routes });
      void readTopicQuestionState(f.a, f.still(), reads)!.plan;
      void readTopicQuestionState(f.a, f.still(), reads)!.plan;
      expect(plans).toHaveBeenCalledTimes(1);

      // A new planning input: the plan is built again.
      f.signal("Shard compaction thresholds were tuned a third time");
      void readTopicQuestionState(f.a, f.still(), reads)!.plan;
      expect(plans).toHaveBeenCalledTimes(2);
    } finally {
      plans.mockRestore();
    }
  });

  test("the plan reads a topic's head words once, not once per record it weighs the topic for", () => {
    const topics = ["Shard compaction windows", "Shard compaction thresholds", "Shard file layout"];
    for (const title of topics) f.seedTopic(title);
    const records = Array.from({ length: 30 }, (_, i) =>
      f.signal(`Shard compaction note number ${i} about files`),
    );
    const state = readTopicQuestionState(f.a, f.still())!;
    const tokens = spyOn(candidatesModule, "subjectTokens");
    try {
      void state.plan;
      // Each record's own words, and each topic's head once per privacy
      // view: far below one head read per record and topic.
      expect(tokens.mock.calls.length).toBeLessThan(records.length * topics.length);
    } finally {
      tokens.mockRestore();
    }
  });
});
