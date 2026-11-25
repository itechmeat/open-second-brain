/**
 * The `topic-new` and `topic-same` operations (change
 * `dream-closed-questions`, design D3, task 2.1).
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
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";

let f: ClosedFixture;

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

function garden(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    f.signal(`Alley garden beds watering notes from meeting ${i}`, { session: `s${i % 2}` }),
  );
}

describe("topic-new", () => {
  test("a qualifying group is asked about, keyed by its leader", () => {
    const records = garden(5);
    const asked = questionsOf("topic-new");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.subject).toBe(records[0]!);
    expect(asked[0]!.input["title"]).toBeDefined();
  });

  test("validate takes a probability and refuses anything else", () => {
    garden(5);
    const item = produced("topic-new", questionsOf("topic-new")[0]!.subject);
    const op = dreamWorkOperation("topic-new")!;
    const base = { provider: "compatible", model: "m" };
    expect(op.validate({ value: { ...base, p: 0.2 } }, item)).toBeNull();
    expect(op.validate({ value: { ...base, p: 1.5 } }, item)).toBe("p must be a probability");
    expect(op.validate({ value: { ...base, choice: "yes" } }, item)).toBe(
      "p must be a probability",
    );
  });

  test("currentInput is stable and changes with a new member, the group keeping its subject", () => {
    garden(5);
    const item = produced("topic-new", questionsOf("topic-new")[0]!.subject);
    const op = dreamWorkOperation("topic-new")!;
    const context = { store: f.a, vault: null, now: f.still() };
    expect(op.currentInput(item, context)?.input_hash).toBe(item.body.input_hash);
    // A sixth member joins the group: its leader, and so its subject, stay.
    garden(1);
    const input = op.currentInput(item, context);
    expect(input).not.toBeNull();
    expect(input!.input_hash).not.toBe(item.body.input_hash);
  });

  test("a group under the thresholds is not asked about", () => {
    garden(3);
    expect(questionsOf("topic-new")).toEqual([]);
  });
});

describe("topic-same", () => {
  test("a pair of similar topics is asked about, the text changing its input", () => {
    const a = f.seedTopic("Shard compaction window tuning");
    const b = f.seedTopic("Shard compaction window settings");
    const asked = questionsOf("topic-same");
    expect(asked.map((q) => q.subject)).toEqual([`${a}..${b}`]);
    const item = produced("topic-same", `${a}..${b}`);
    const op = dreamWorkOperation("topic-same")!;
    const context = { store: f.a, vault: null, now: f.still() };
    expect(op.currentInput(item, context)?.input_hash).toBe(item.body.input_hash);
    expect(
      op.validate({ value: { provider: "p", model: "m", choice: "same", confidence: 0.8 } }, item),
    ).toBeNull();
    expect(
      op.validate({ value: { provider: "p", model: "m", choice: "merge", confidence: 0.8 } }, item),
    ).toContain("not one of the item's options");
    f.seedItem(b, "topic-rename", { title: "Shard compaction window settings and limits" });
    expect(op.currentInput(item, context)!.input_hash).not.toBe(item.body.input_hash);
  });
});
