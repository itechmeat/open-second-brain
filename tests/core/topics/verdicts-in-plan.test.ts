/**
 * Model verdicts decide the topic plan only where their subject still
 * matches the fold read under the planning lock (design D10, D20; change
 * `dream-closed-questions` D2). With `verdicts` absent, `planTopics`
 * routes and creates nothing and lists the questions it waits on; a
 * verdict whose record is assigned meanwhile, whose topic is merged,
 * closed or of another scope, whose route is blocked, or whose group has
 * changed, is ignored and the subject waits.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StorePartition } from "../../../src/core/store/constants.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { topicCandidates } from "../../../src/core/topics/candidates.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_STATUS_KIND,
} from "../../../src/core/topics/constants.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { planTopics, type TopicPlan } from "../../../src/core/topics/plan.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
import {
  emptyTopicVerdicts,
  topicGroupKey,
  type TopicVerdictBody,
  type TopicVerdicts,
} from "../../../src/core/topics/verdicts.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { answerClosedQuestions } from "../../helpers/closed-answers.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";
import { seedTopicRecord } from "../view/fixtures/seed.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
let clock = T0;
const now = () => (clock += 1000);

const SETTINGS = { minRecords: 2, minSessions: 1, quietDays: 30 };

let m: Machines;
let a: StoreHandle;
beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-topics-verdicts-");
  a = m.open("dev-a");
});
afterEach(() => m.cleanup());

let seq = 0;
function signal(text: string, session = "s1"): string {
  clock += 1000;
  seq += 1;
  return appendRecord(
    a,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: `sig-2026-11-02-v${seq}`,
        path: `Brain/inbox/v${seq}.md`,
        staged: false,
        frontmatter: { principle: text, project: "o2b", session },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now },
  ).record.id;
}

function seedTopic(title: string, scope = "project:o2b"): string {
  clock += 1000;
  const topic = newUlid(clock);
  seedTopicRecord(a, clock, TOPIC_CREATE_KIND, topic, { title, scope });
  return topic;
}

function planWith(verdicts?: TopicVerdicts): TopicPlan {
  const records = (["shared", "private"] as const).flatMap((p) =>
    readPartition(join(m.root("dev-a"), p)).flatMap((s) => s.records),
  );
  const privateIds = new Set(
    (["private"] as const)
      .flatMap((p: StorePartition) => readPartition(join(m.root("dev-a"), p)))
      .flatMap((s) => s.records)
      .map((r) => r.id),
  );
  const fold = foldTopics(records, { privateIds });
  return planTopics(fold, topicCandidates(records, privateIds), SETTINGS, clock, verdicts);
}

function verdictOf(use: TopicVerdictBody["use"], confidence = 0.9): TopicVerdictBody {
  return {
    use,
    model: "test-model-1",
    provider: "test-preset",
    version: 1,
    mode: "enforce",
    confidence,
  };
}

describe("planTopics with verdicts", () => {
  test("with verdicts absent the plan routes nothing and asks, also with empty verdicts", () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction thresholds were tuned today", "s1");
    const deterministic = planWith();
    expect(deterministic.routes).toEqual([]);
    expect(deterministic.asks.routes).toEqual([{ record: r1, topics: [topic] }]);
    expect(planWith(emptyTopicVerdicts())).toEqual(deterministic);
  });

  test("a model route to a topic the overlap rule would not pick is applied", () => {
    seedTopic("Shard compaction keeps monthly shard files small");
    const other = seedTopic("Garden watering schedule for the alley beds");
    const r1 = signal("Shard compaction thresholds were tuned today", "s1");
    const plan = planWith({
      ...emptyTopicVerdicts(),
      routes: new Map([
        [r1, { topic: other, privateInput: false, verdict: verdictOf("topic_route") }],
      ]),
    });
    expect(plan.routes.map((r) => [r.record, r.topic, r.verdict?.use])).toEqual([
      [r1, other, "topic_route"],
    ]);
  });

  test("a model none verdict leaves the record free for grouping", () => {
    seedTopic("Shard compaction keeps monthly shard files small");
    const members = [
      signal("Shard compaction notes from meeting one", "s1"),
      signal("Shard compaction notes from meeting two", "s2"),
    ];
    const none = planWith({
      ...emptyTopicVerdicts(),
      routes: new Map(
        members.map((id) => [
          id,
          { topic: null, privateInput: false, verdict: verdictOf("topic_route") },
        ]),
      ),
    });
    expect(none.routes).toEqual([]);
    // Free for grouping: the group is asked about; it is created only on an approval.
    expect(none.creates).toEqual([]);
    expect(none.asks.groups.map((g) => [...g.members].toSorted())).toEqual([members.toSorted()]);
  });

  test("a note the accepted verdicts of the pass hide never joins a group", () => {
    const members = [
      signal("Shard compaction notes from meeting one", "s1"),
      signal("Shard compaction notes from meeting two", "s2"),
      signal("Shard compaction notes from meeting three", "s3"),
    ];
    const hidden = members[2]!;
    const plan = planWith({
      ...emptyTopicVerdicts(),
      hidden: new Map([[hidden, verdictOf("human_readable")]]),
    });
    // The hide is written after the plan: a group that took the note
    // would hold it for ever.
    const grouped = plan.asks.groups.flatMap((g) => [...g.members]);
    expect(grouped.toSorted()).toEqual(members.slice(0, 2).toSorted());
    expect(grouped).not.toContain(hidden);
  });

  test("a verdict whose record is already assigned is ignored", () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction thresholds were tuned today", "s1");
    seedTopicRecord(a, clock, TOPIC_ASSIGN_KIND, topic, { record: r1 });
    const plan = planWith({
      ...emptyTopicVerdicts(),
      routes: new Map([[r1, { topic, privateInput: false, verdict: verdictOf("topic_route") }]]),
    });
    expect(plan.routes).toEqual([]);
  });

  test("a verdict onto a closed or merged topic is ignored, the deterministic rule applying", () => {
    const t1 = seedTopic("Shard compaction keeps monthly shard files small");
    const t2 = seedTopic("Garden watering schedule for the alley beds");
    seedTopicRecord(a, clock, TOPIC_STATUS_KIND, t2, { status: "closed" });
    const r1 = signal("Garden watering needs a schedule this week", "s1");
    const deterministic = planWith();
    const plan = planWith({
      ...emptyTopicVerdicts(),
      routes: new Map([
        [r1, { topic: t2, privateInput: false, verdict: verdictOf("topic_route") }],
      ]),
    });
    expect(plan).toEqual(deterministic);
    void t1;
  });

  test("a verdict whose route the user blocked is ignored", () => {
    const t1 = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction thresholds were tuned today", "s1");
    seedTopicRecord(a, clock, "unassign", t1, { record: r1 }, { authority: "agent" });
    const deterministic = planWith();
    expect(deterministic.routes).toEqual([]);
    const plan = planWith({
      ...emptyTopicVerdicts(),
      routes: new Map([
        [r1, { topic: t1, privateInput: false, verdict: verdictOf("topic_route") }],
      ]),
    });
    expect(plan).toEqual(deterministic);
  });

  test("a veto skips its group until it grows by half; an approval rides the create", () => {
    const members = [
      signal("Alley garden beds need watering notes", "s1"),
      signal("Alley garden beds watering schedule drafted", "s2"),
    ];
    const key = topicGroupKey(members);
    const veto = { verdict: verdictOf("topic_new", 0.2), veto: true, members: 2 };
    const vetoed = planWith({ ...emptyTopicVerdicts(), vetoes: new Map([[key, veto]]) });
    expect(vetoed.creates).toEqual([]);
    expect(vetoed.asks.groups).toEqual([]);
    // A group that grew by half (a third record joined) is asked again.
    members.push(signal("Alley garden beds watering review filed", "s3"));
    const changed = planWith({ ...emptyTopicVerdicts(), vetoes: new Map([[key, veto]]) });
    expect(changed.creates).toEqual([]);
    expect(changed.asks.groups.map((g) => g.key)).toEqual([topicGroupKey(members)]);
    // Approval with no wording: the group waits for the launched agent's
    // title and goal (change `dream-launched-agent`).
    const approvedOnly = planWith({
      ...emptyTopicVerdicts(),
      vetoes: new Map([[topicGroupKey(members), { verdict: verdictOf("topic_new"), veto: false }]]),
    });
    expect(approvedOnly.creates).toEqual([]);
    expect(approvedOnly.asks.wordings.map((g) => g.key)).toEqual([topicGroupKey(members)]);
    // Approval and wording: the create carries the model verdict, the
    // agent's title and goal and their author.
    const approved = planWith({
      ...emptyTopicVerdicts(),
      vetoes: new Map([[topicGroupKey(members), { verdict: verdictOf("topic_new"), veto: false }]]),
      wordings: new Map([
        [
          topicGroupKey(members),
          {
            title: "Alley garden",
            goal: "Keep the beds watered.",
            agent: "claude",
            model: "m-1",
            item: "i1",
          },
        ],
      ]),
    });
    expect(approved.creates).toHaveLength(1);
    expect(approved.creates[0]!).toMatchObject({
      title: "Alley garden",
      goal: "Keep the beds watered.",
      author: { agent: "claude", model: "m-1", item: "i1" },
    });
    expect(approved.creates[0]!.verdict?.use).toBe("topic_new");
    expect(approved.creates[0]!.verdict?.model).toBe("test-model-1");
  });
});

describe("the planning write path stores verdicts", () => {
  beforeEach(() => {
    claimViewWriter(a, { agent: "dream", now });
    claimSettled(a, readViewWriter(a, now));
  });

  test("a model route writes an assign with authority model and the verdict", () => {
    seedTopic("Shard compaction keeps monthly shard files small");
    const t2 = seedTopic("Garden watering schedule for the alley beds");
    const r1 = signal("Shard compaction and garden watering schedules were tuned today", "s1");
    // The model's answer: the garden topic, which the overlap rule ranks second.
    answerClosedQuestions(
      a,
      (item) => (item.operation === "topic-route" ? { choice: t2, confidence: 0.9 } : null),
      { now },
    );
    const report = runTopicPlanning(a, { agent: "dream", now });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.routed.map((r) => r.record)).toEqual([r1]);
    const records = readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records);
    const assign = records.find((r) => r.kind === TOPIC_ASSIGN_KIND && r.body["record"] === r1);
    expect(assign?.topic).toBe(t2);
    expect(assign?.body["authority"]).toBe("model");
    const stored = assign?.body["verdict"] as TopicVerdictBody | undefined;
    expect(stored?.use).toBe("topic_route");
    expect(stored?.model).toBe("test-model");
    expect(stored?.mode).toBe("enforce");
  });

  test("with no answer no route is written", () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction thresholds were tuned today", "s1");
    const report = runTopicPlanning(a, { agent: "dream", now });
    expect(report.status).toBe("planned");
    const records = readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records);
    const assign = records.find((r) => r.kind === TOPIC_ASSIGN_KIND && r.body["record"] === r1);
    expect(assign).toBeUndefined();
    void topic;
  });
});
