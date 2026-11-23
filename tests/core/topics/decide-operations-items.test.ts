/**
 * The `event-kind`, `question-resolved` and `milestone-done` operations
 * (change `dream-closed-questions`, design D3, task 2.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dreamWorkOperation } from "../../../src/core/brain/dream-queue/operations.ts";
import { produceWork } from "../../../src/core/brain/dream-queue/queue.ts";
import {
  closedProduceSpec,
  closedQuestion,
  closedQuestions,
  readTopicQuestionState,
  type ClosedOperation,
} from "../../../src/core/topics/decide-operations.ts";
import { TOPIC_MILESTONE_KIND, TOPIC_QUESTION_KIND } from "../../../src/core/topics/constants.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";

let f: ClosedFixture;
const context = () => ({ store: f.a, vault: null, now: f.still() });

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function questionsOf(op: ClosedOperation) {
  return closedQuestions(readTopicQuestionState(f.a, f.still())!).filter((q) => q.operation === op);
}

function produced(op: ClosedOperation, subject: string) {
  const question = closedQuestion(readTopicQuestionState(f.a, f.still())!, op, subject)!;
  const { id } = produceWork(f.queue, closedProduceSpec(question));
  return f.items(op).find((i) => i.id === id)!;
}

describe("event-kind", () => {
  test("a held record with no derived item is asked; an answer outside the kinds is refused", () => {
    const topic = f.seedTopic("Shard compaction");
    const record = f.signal("We decided to compact shards monthly");
    f.holdRecord(topic, record);
    expect(questionsOf("event-kind").map((q) => q.subject)).toEqual([record]);
    const item = produced("event-kind", record);
    const op = dreamWorkOperation("event-kind")!;
    expect(op.validate({ value: { provider: "p", model: "m", choice: "decision" } }, item)).toBe(
      null,
    );
    expect(op.validate({ value: { provider: "p", model: "m", choice: "idea" } }, item)).toContain(
      "not one of the item's options",
    );
    expect(op.currentInput(item, context())?.input_hash).toBe(item.body.input_hash);
    f.seedItem(topic, "topic-rename", { title: "Shard compaction policy" });
    expect(op.currentInput(item, context())!.input_hash).not.toBe(item.body.input_hash);
  });

  test("an unheld record is not asked about", () => {
    f.signal("We decided to compact shards monthly");
    expect(questionsOf("event-kind")).toEqual([]);
  });
});

describe("question-resolved", () => {
  test("a held record newer than an open question is asked; it is gone once the question is answered", () => {
    const topic = f.seedTopic("Shard compaction");
    const question = f.seedItem(topic, TOPIC_QUESTION_KIND, { text: "How often to compact?" });
    const record = f.signal("Compaction runs monthly from now on");
    f.holdRecord(topic, record);
    const asked = questionsOf("question-resolved");
    expect(asked.map((q) => q.subject)).toEqual([record]);
    expect(asked[0]!.options).toEqual([`${topic}/${question}`, "none"]);
    const item = produced("question-resolved", record);
    const op = dreamWorkOperation("question-resolved")!;
    expect(op.currentInput(item, context())?.input_hash).toBe(item.body.input_hash);
    f.seedItem(topic, "question-resolved", { question, answer: "monthly" });
    expect(op.currentInput(item, context())).toBeNull();
  });
});

describe("milestone-done", () => {
  test("its input is the milestone and the newest held records, so a new record supersedes it", () => {
    const topic = f.seedTopic("Shard compaction");
    const milestone = f.seedItem(topic, TOPIC_MILESTONE_KIND, { text: "Ship monthly compaction" });
    const r1 = f.signal("Monthly compaction is merged");
    f.holdRecord(topic, r1);
    const subject = `${topic}/${milestone}`;
    expect(questionsOf("milestone-done").map((q) => q.subject)).toEqual([subject]);
    const item = produced("milestone-done", subject);
    const op = dreamWorkOperation("milestone-done")!;
    expect(op.validate({ value: { provider: "p", model: "m", p: 0.9 } }, item)).toBeNull();
    expect(op.currentInput(item, context())?.input_hash).toBe(item.body.input_hash);
    const r2 = f.signal("Monthly compaction ran in production");
    f.holdRecord(topic, r2);
    expect(op.currentInput(item, context())!.input_hash).not.toBe(item.body.input_hash);
  });

  test("a milestone with no newer held record is not asked about", () => {
    const topic = f.seedTopic("Shard compaction");
    const r1 = f.signal("Monthly compaction is planned");
    f.holdRecord(topic, r1);
    f.seedItem(topic, TOPIC_MILESTONE_KIND, { text: "Ship monthly compaction" });
    expect(questionsOf("milestone-done")).toEqual([]);
  });
});
