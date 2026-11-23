/**
 * The `topic-route` operation and the names of the closed questions
 * (change `dream-closed-questions`, design D3, task 2.1): the answer
 * shape, the input an item is produced for, and the two spellings of a
 * use's name.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { dreamWorkOperation } from "../../../src/core/brain/dream-queue/operations.ts";
import { produceWork, takeWork } from "../../../src/core/brain/dream-queue/queue.ts";
import {
  CLOSED_OPERATIONS,
  closedProduceSpec,
  closedQuestion,
  operationOfUse,
  readTopicQuestionState,
  standingMergeHints,
  useOfOperation,
} from "../../../src/core/topics/decide-operations.ts";
import { DREAM_TOPIC_USES } from "../../../src/core/decision-model/questions-topics.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import * as streamRead from "../../../src/core/store/read/stream-read.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function routeItem(record: string) {
  const state = readTopicQuestionState(f.a, f.still())!;
  const question = closedQuestion(state, "topic-route", record);
  expect(question).not.toBeNull();
  const { id } = produceWork(f.queue, closedProduceSpec(question!));
  return f.items("topic-route").find((i) => i.id === id)!;
}

function inputOf(item: ReturnType<typeof routeItem>) {
  return dreamWorkOperation("topic-route")!.currentInput(item, {
    store: f.a,
    vault: null,
    now: f.still(),
  });
}

describe("names", () => {
  test("every use maps to its operation and back", () => {
    expect(DREAM_TOPIC_USES.map(operationOfUse)).toEqual([
      "topic-route",
      "event-kind",
      "human-readable",
      "topic-new",
      "topic-same",
      "question-resolved",
      "milestone-done",
    ]);
    for (const op of CLOSED_OPERATIONS) expect(operationOfUse(useOfOperation(op)!)).toBe(op);
    expect(useOfOperation("rollup-summary")).toBeNull();
  });

  test("each operation is registered and applied by planning", () => {
    for (const op of CLOSED_OPERATIONS) {
      expect(dreamWorkOperation(op)?.appliedBy).toBe("planning");
    }
  });
});

describe("validate", () => {
  test("accepts the shape, refuses a choice outside the options, accepts no confidence", () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    const item = routeItem(record);
    const op = dreamWorkOperation("topic-route")!;
    const base = { provider: "compatible", model: "m" };
    expect(op.validate({ value: { ...base, choice: topic, confidence: 0.9 } }, item)).toBeNull();
    expect(op.validate({ value: { ...base, choice: "none", confidence: 0.9 } }, item)).toBeNull();
    expect(op.validate({ value: { ...base, choice: topic } }, item)).toBeNull();
    expect(op.validate({ value: { ...base, choice: "T0", confidence: 0.9 } }, item)).toContain(
      "not one of the item's options",
    );
    expect(op.validate({ value: { choice: topic, confidence: 0.9 } }, item)).toBe(
      "missing provider",
    );
    expect(op.validate({ value: { ...base, choice: topic, confidence: 2 } }, item)).toBe(
      "confidence must be a probability",
    );
  });
});

describe("currentInput", () => {
  test("is stable for the same state", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    const item = routeItem(record);
    expect(inputOf(item)?.input_hash).toBe(item.body.input_hash);
    expect(inputOf(item)?.input_hash).toBe(item.body.input_hash);
  });

  test("changes when an option appears", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    const item = routeItem(record);
    f.seedTopic("Shard compaction thresholds tuning log");
    const input = inputOf(item);
    expect(input).not.toBeNull();
    expect(input!.input_hash).not.toBe(item.body.input_hash);
  });

  test("a changed question that becomes private is superseded into the private partition", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    const item = routeItem(record);
    f.seedTopic("Shard compaction tuning <private>HALCYON</private>");

    const taken = takeWork(f.queue, { run: "privacy-test" }).item;
    expect(item.partition).toBe("shared");
    expect(taken?.partition).toBe("private");
  });

  test("changes when a topic's head text changes", () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    const item = routeItem(record);
    f.seedItem(topic, "topic-rename", { title: "Shard compaction keeps shard files tidy" });
    expect(inputOf(item)!.input_hash).not.toBe(item.body.input_hash);
  });

  test("is null when the record was assigned meanwhile", () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    const item = routeItem(record);
    f.holdRecord(topic, record);
    expect(inputOf(item)).toBeNull();
  });
});

test("question state is unavailable when its standing queue read is incomplete", () => {
  const read = streamRead.readStreamRecords;
  const spy = spyOn(streamRead, "readStreamRecords").mockImplementation(
    (root, partition, ref, options) => {
      const result = read(root, partition, ref, options);
      return ref.stream === "dream-work"
        ? { ...result, unreadable: [...result.unreadable, "injected-incomplete-shard"] }
        : result;
    },
  );
  try {
    expect(readTopicQuestionState(f.a, f.still())).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

test("question state is unavailable when its standing queue read has pending records", () => {
  const read = streamRead.readStreamRecords;
  const spy = spyOn(streamRead, "readStreamRecords").mockImplementation(
    (root, partition, ref, options) => {
      const result = read(root, partition, ref, options);
      return ref.stream === "dream-work"
        ? { ...result, pendingKinds: new Map([["dream-work-item", 1]]) }
        : result;
    },
  );
  try {
    expect(readTopicQuestionState(f.a, f.still())).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

test("standing merge hints are unavailable when a queue shard is unreadable", () => {
  const read = streamRead.readStreamRecords;
  const spy = spyOn(streamRead, "readStreamRecords").mockImplementation(
    (root, partition, ref, options) => {
      const result = read(root, partition, ref, options);
      return ref.stream === "dream-work"
        ? { ...result, unreadable: [...result.unreadable, "injected-incomplete-shard"] }
        : result;
    },
  );
  try {
    expect(standingMergeHints(f.a.root, f.a.partitions)).toBeNull();
  } finally {
    spy.mockRestore();
  }
});
