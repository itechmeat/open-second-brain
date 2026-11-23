/**
 * Producing the closed questions (change `dream-closed-questions`, design
 * D3, spec "Every closed question is a queue item", task 3.1): one item
 * per eligible subject, however old, oldest first, never twice for the
 * same input, bounded only by the deadline.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { answerWork, produceWork, takeWork } from "../../../src/core/brain/dream-queue/queue.ts";
import { dreamWorkResourceBarrier } from "../../../src/core/brain/dream-queue/records.ts";
import { TOPIC_USE_QUESTION_VERSION } from "../../../src/core/decision-model/questions-topics.ts";
import {
  closedProduceSpec,
  closedQuestion,
  closedQuestions,
  readTopicQuestionState,
} from "../../../src/core/topics/decide-operations.ts";
import { PRODUCE_CHUNK, produceTopicQuestions } from "../../../src/core/topics/decide-produce.ts";
import { closedFixture, T0, type ClosedFixture } from "./fixtures/closed-fixture.ts";

let f: ClosedFixture;
const DAY = 24 * 3600_000;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function produce(until = Number.POSITIVE_INFINITY, clock: () => number = f.still) {
  const state = readTopicQuestionState(f.a, f.still())!;
  return produceTopicQuestions(f.queue, state, { until, clock });
}

describe("produceTopicQuestions", () => {
  test("one item per eligible subject for each operation", () => {
    const shard = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.seedTopic("Shard compaction window settings");
    const routed = f.signal("Shard compaction thresholds were tuned today");
    const held = f.signal("We decided to compact shards monthly");
    f.holdRecord(shard, held);
    const note = f.note("A note for the weekly history");
    const result = produce();
    const subjects = (op: string) => f.items(op).map((i) => i.body.subject);
    expect(subjects("topic-route")).toEqual([routed]);
    expect(subjects("event-kind")).toEqual([held]);
    expect(subjects("human-readable")).toEqual([note]);
    expect(subjects("topic-same")).toHaveLength(1);
    expect(result.produced).toBe(f.items().length);
    expect(result.left).toBe(0);
    expect(result.asked["topic-route"]).toBe(1);
  });

  test("records older than eight weeks get items, the oldest first", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const fresh = f.signal("Shard compaction thresholds were tuned today", { at: T0 + DAY });
    const old = f.signal("Shard compaction thresholds were tuned in spring", {
      at: T0 - 90 * DAY,
    });
    produce();
    expect(f.items("topic-route").map((i) => i.body.subject)).toEqual([old, fresh]);
  });

  test("a second run produces none", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.signal("Shard compaction thresholds were tuned today");
    f.note("A note");
    expect(produce().produced).toBe(2);
    const again = produce();
    expect(again.produced).toBe(0);
    expect(again.existing).toBe(2);
  });

  test("produces wording beside an already queued topic question without losing resource barriers", () => {
    const members = [
      f.signal("Alley garden beds watering notes from meeting 0", { session: "s1" }),
      f.signal("Alley garden beds watering notes from meeting 1", { session: "s1" }),
      f.signal("Alley garden beds watering notes from meeting 2", { session: "s2" }),
      f.signal("Alley garden beds watering notes from meeting 3", { session: "s2" }),
      f.signal("Alley garden beds watering notes from meeting 4", { session: "s2" }),
    ];
    const state = readTopicQuestionState(f.a, f.still())!;
    const question = closedQuestions(state).find(
      (candidate) => candidate.operation === "topic-new",
    )!;
    const resource = `record:${members[0]!}`;
    produceWork(f.queue, {
      operation: "private-prior",
      subject: "private-prior",
      occurrence: "0",
      input: {},
      prompt_version: "1",
      schema_version: "1",
      answer_schema: {},
      after: [],
      resources: [resource],
      evidence: [],
      payload: {},
      sources: ["private"],
    });
    const { id: topicNew } = produceWork(f.queue, closedProduceSpec(question));
    const taken = takeWork(f.queue, { run: "answer", filter: (item) => item.id === topicNew });
    expect(taken.item).not.toBeNull();
    const answer = answerWork(f.queue, {
      item: topicNew,
      generation: taken.item!.generation,
      lease_token: taken.item!.lease_token,
      value: { p: 1, provider: "test", model: "test-model" },
      agent: "test",
      model: "test-model",
    });
    expect(answer.status).toBe("accepted");

    const result = produce();

    expect(result.produced).toBe(1);
    expect(f.items("topic-new")).toHaveLength(1);
    expect(f.items("topic-wording")).toHaveLength(1);
    expect(f.items("topic-wording")[0]!.body.private_resource_barriers).toContain(
      dreamWorkResourceBarrier(resource),
    );
    expect(produce().produced).toBe(0);
    expect(f.items("topic-wording")).toHaveLength(1);
  });

  test("an item of an older question version does not stand for the current one", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds were tuned today");
    const question = closedQuestion(
      readTopicQuestionState(f.a, f.still())!,
      "topic-route",
      record,
    )!;
    produceWork(f.queue, { ...closedProduceSpec(question), prompt_version: "1" });
    expect(produce().produced).toBe(1);
    const versions = f.items("topic-route").map((i) => i.body.prompt_version);
    expect(versions).toEqual(["1", String(TOPIC_USE_QUESTION_VERSION.topic_route)]);
  });

  test("the eligibility thresholds still hold a group back", () => {
    for (let i = 0; i < 3; i++) {
      f.signal(`Alley garden beds watering notes from meeting ${i}`, { session: `s${i}` });
    }
    produce();
    expect(f.items("topic-new")).toEqual([]);
    for (let i = 3; i < 5; i++) {
      f.signal(`Alley garden beds watering notes from meeting ${i}`, { session: `s${i}` });
    }
    produce();
    expect(f.items("topic-new")).toHaveLength(1);
  });

  test("a private subject's payload holds the real text, in the private partition", () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction thresholds for the secret cluster", {
      partition: "private",
    });
    produce();
    const [item] = f.items("topic-route");
    expect(item!.body.subject).toBe(record);
    expect(item!.partition).toBe("private");
    expect(item!.body.payload["text"]).toBe("Shard compaction thresholds for the secret cluster");
  });

  test("production stops at the deadline, says how many are left, and the next run continues", () => {
    const n = PRODUCE_CHUNK + 20;
    for (let i = 0; i < n; i++) f.note(`Note number ${i}`, T0 - (n - i) * 60_000);
    let ticks = 0;
    // The deadline passes once the first chunk is written.
    const first = produce(1, () => (ticks++ === 0 ? 0 : 2));
    expect(first.produced).toBe(PRODUCE_CHUNK);
    expect(first.left).toBe(20);
    const second = produce();
    expect(second.produced).toBe(20);
    expect(second.left).toBe(0);
    expect(f.items("human-readable")).toHaveLength(n);
  }, 30_000);

  test("a bounded later pass reaches subjects after the queued prefix", () => {
    const n = PRODUCE_CHUNK * 2 + 20;
    for (let i = 0; i < n; i++) f.note(`Later note ${i}`, T0 - (n - i) * 60_000);
    let ticks = 0;
    const first = produce(1, () => (ticks++ === 0 ? 0 : 2));
    expect(first.produced).toBe(PRODUCE_CHUNK);
    ticks = 0;
    const second = produce(1, () => (ticks++ === 0 ? 0 : 2));
    expect(second.produced).toBe(PRODUCE_CHUNK);
    expect(second.existing).toBe(PRODUCE_CHUNK);
    expect(second.left).toBe(20);
  }, 30_000);
});
