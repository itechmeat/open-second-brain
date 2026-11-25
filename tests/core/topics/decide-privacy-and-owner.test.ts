/**
 * The closed questions on the topic rules the planner holds (design D20;
 * change `dream-closed-questions`, design D3.7, D4.3):
 *
 *  - a proposal for an item a merged topic shows is written under the
 *    item's owner, so the fold finds it;
 *  - a private item, or a private head field of a shared topic, never
 *    reaches a hosted provider: the item built from it is private and
 *    waits for a local executor;
 *  - a note of any age is asked about, whatever date the run is for;
 *  - a verdict write that fails part way still counts what landed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_MERGE_KIND,
  TOPIC_MILESTONE_KIND,
  TOPIC_QUESTION_KIND,
  TOPIC_RENAME_KIND,
} from "../../../src/core/topics/constants.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { writeVerdictRecords } from "../../../src/core/topics/verdict-writes.ts";
import { emptyTopicVerdicts, type TopicVerdictBody } from "../../../src/core/topics/verdicts.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { closedFixture, T0, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import { ask, plan, planAndWord } from "./fixtures/closed-run.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function topicRecord(
  kind: string,
  topic: string,
  body: Record<string, unknown>,
  partition: "shared" | "private" = "shared",
): string {
  return appendRecord(
    f.a,
    {
      partition,
      stream: "topics",
      kind,
      agent: "seed",
      topic,
      body: { authority: "agent", ...body },
    },
    { now: f.now },
  ).record.id;
}

function sharedRecords() {
  return readPartition(join(f.m.root("dev-a"), "shared")).flatMap((s) => s.records);
}

/** The release reasons of the private items of `operation`. */
function refused(operation: string): Array<string | undefined> {
  return f
    .items(operation)
    .filter((i) => i.partition === "private")
    .map((i) => i.last_release?.reason);
}

describe("the closed questions on the planner's topic rules", () => {
  test("a completion of a merged topic's milestone is written under the item's owner", async () => {
    const owner = f.seedTopic("Shard compaction keeps monthly shard files small");
    const milestone = "m-window";
    topicRecord(TOPIC_MILESTONE_KIND, owner, {
      item: milestone,
      text: "Ship the first compaction window",
    });
    const home = f.seedTopic("Shard compaction rollout on every machine");
    topicRecord(TOPIC_MERGE_KIND, owner, { into: home });
    for (const text of [
      "Shard compaction window shipped and the rollup ledger closed",
      "Shard compaction window verified on every machine",
    ]) {
      topicRecord(TOPIC_ASSIGN_KIND, home, { record: f.signal(text) });
    }
    f.tune("milestone_done", { done_min: 0.8 });
    await ask(
      f,
      "milestone_done:enforce",
      new FakeDecisionProvider({ answer: (id) => (id.startsWith("done_") ? 0.9 : undefined) }),
    );
    const report = plan(f);
    expect(report.status === "planned" ? report.completions : -1).toBe(1);
    const written = sharedRecords().filter((r) => r.kind === "milestone-done");
    expect(written.map((r) => r.topic)).toEqual([owner]);
    // The topic that shows the merged one's items shows the proposal.
    const item = foldTopics(sharedRecords())
      .topics.get(home)
      ?.items.find((i) => i.id === milestone);
    expect(item?.doneProposed).toBeDefined();
    expect(item?.done).toBeUndefined();
  });

  test("a completion judged on private evidence lands in private", async () => {
    // Private records of milestone_done may leave here, so the private
    // evidence is sent: the proposal derived from it must not be shared.
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(TOPIC_MILESTONE_KIND, topic, {
      item: "m-window",
      text: "Ship the first compaction window",
    });
    topicRecord(TOPIC_ASSIGN_KIND, topic, {
      record: f.signal("Shard compaction window shipped, said the acquisition memo", {
        partition: "private",
      }),
    });
    f.tune("milestone_done", { done_min: 0.8 });
    await ask(
      f,
      "milestone_done:enforce",
      new FakeDecisionProvider({ answer: (id) => (id.startsWith("done_") ? 0.95 : undefined) }),
      { OPEN_SECOND_BRAIN_DECISION_MODEL_PRIVATE_USES: "milestone_done" },
    );
    expect(f.items("milestone-done")[0]!.partition).toBe("private");
    const report = plan(f);
    expect(report.status === "planned" ? report.completions : -1).toBe(1);
    expect(sharedRecords().filter((r) => r.kind === "milestone-done")).toEqual([]);
    const privateDone = readPartition(join(f.m.root("dev-a"), "private"))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === "milestone-done");
    expect(privateDone).toHaveLength(1);
  });

  test("a private milestone of a shared topic is never sent to a hosted provider", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(
      TOPIC_MILESTONE_KIND,
      topic,
      { item: "m-secret", text: "Ship the Halcyon compaction window" },
      "private",
    );
    topicRecord(TOPIC_ASSIGN_KIND, topic, {
      record: f.signal("Shard compaction window shipped and the rollup ledger closed"),
    });
    const fake = new FakeDecisionProvider({});
    await ask(f, "milestone_done:shadow", fake);
    expect(fake.requests).toEqual([]);
    expect(refused("milestone-done")).toEqual(["egress-refused"]);
  });

  test("a private rename of a shared topic never reaches a hosted provider", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(
      TOPIC_RENAME_KIND,
      topic,
      { title: "Halcyon shard compaction for the acquisition" },
      "private",
    );
    topicRecord(TOPIC_QUESTION_KIND, topic, {
      item: "q-window",
      text: "Which compaction window ships first",
    });
    topicRecord(TOPIC_ASSIGN_KIND, topic, {
      record: f.signal("Shard compaction window decided: the nightly one ships first"),
    });
    const fake = new FakeDecisionProvider({});
    await ask(f, "question_resolved:shadow", fake);
    expect(JSON.stringify(fake.requests)).not.toContain("Halcyon");
    // The item's input carries the private title: it waits for a local executor.
    expect(fake.requests).toEqual([]);
    expect(refused("question-resolved")).toEqual(["egress-refused"]);
  });

  test("a note of any age is asked about, whatever date the run is for", async () => {
    f.note("Routine heartbeat of the nightly compaction job", T0 - 20 * WEEK_MS);
    const fake = new FakeDecisionProvider({});
    await ask(f, "human_readable:shadow", fake);
    const asked = fake.requests.flatMap((r) =>
      Object.values((r.state as { records: Record<string, string> }).records),
    );
    expect(asked.join(" ")).toContain("Routine heartbeat");
  });

  test("a verdict write that fails part way still counts what landed", () => {
    const verdict: TopicVerdictBody = {
      use: "human_readable",
      model: "m",
      provider: "p",
      version: 1,
      mode: "enforce",
      confidence: 0.1,
    };
    const verdicts = {
      ...emptyTopicVerdicts(),
      hidden: new Map([
        ["note-1", verdict],
        ["note-2", verdict],
      ]),
    };
    const counts = { derived: 0, resolutions: 0, completions: 0, hidden: 0, kept: 0 };
    let calls = 0;
    expect(() =>
      writeVerdictRecords({
        append: () => {
          calls += 1;
          if (calls > 1) throw new Error("disk full");
          return "rec-1";
        },
        fold: foldTopics([]),
        plan: {
          routes: [],
          creates: [],
          splits: [],
          merges: [],
          quiet: [],
          shortfall: null,
          asks: { routes: [], groups: [], wordings: [] },
        },
        candidatesById: new Map(),
        verdicts,
        counts,
        judgedNotes: new Set(),
      }),
    ).toThrow("disk full");
    expect(counts.hidden).toBe(1);
  });
});

describe("side texts and private records against a hosted provider", () => {
  test("a <private> region in a shared topic title, question or milestone never reaches it", async () => {
    // A legacy or foreign writer's shared records that carry a region.
    const topic = f.seedTopic(
      "Shard compaction <private>HALCYON-TITLE</private> keeps shard files small",
    );
    topicRecord(TOPIC_QUESTION_KIND, topic, {
      item: "q-window",
      text: "Which compaction window <private>HALCYON-QUESTION</private> ships first",
    });
    topicRecord(TOPIC_MILESTONE_KIND, topic, {
      item: "m-window",
      text: "Ship the <private>HALCYON-MILESTONE</private> compaction window",
    });
    topicRecord(TOPIC_ASSIGN_KIND, topic, {
      record: f.signal("Shard compaction window shipped and the question settled"),
    });
    f.signal("Shard compaction keeps shard files small after the window");
    const fake = new FakeDecisionProvider({});
    await ask(
      f,
      "topic_route:shadow,event_kind:shadow,question_resolved:shadow,milestone_done:shadow",
      fake,
    );
    // Every item whose input carries a region is private: nothing of it is sent.
    expect(JSON.stringify(fake.requests)).not.toContain("HALCYON");
    const operations = ["topic-route", "event-kind", "question-resolved", "milestone-done"];
    const items = operations.flatMap((op) => f.items(op));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      if (item.partition === "private") expect(item.last_release?.reason).toBe("egress-refused");
    }
  });

  test("a private record is never sent for event_kind or question_resolved, nor named in a call record", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(TOPIC_QUESTION_KIND, topic, {
      item: "q-window",
      text: "Which compaction window ships first",
    });
    const secret = f.signal("PRIVATE-TEXT the compaction window is the acquisition date", {
      partition: "private",
    });
    topicRecord(TOPIC_ASSIGN_KIND, topic, { record: secret });
    topicRecord(TOPIC_ASSIGN_KIND, topic, {
      record: f.signal("Shard compaction window answered: the first one ships"),
    });
    const fake = new FakeDecisionProvider({});
    await ask(f, "event_kind:shadow,question_resolved:shadow", fake);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(fake.requests)).not.toContain("PRIVATE-TEXT");
    const calls = listDecisionModelCalls(f.vault);
    expect(calls.length).toBeGreaterThan(0);
    // A call record names the item and the operation, never the private record.
    expect(JSON.stringify(calls)).not.toContain(secret);
  });

  test("a private record of the same theme never joins a shared group or its question", async () => {
    // Private records group apart from shared ones: the ten shared records
    // are asked about without the private one, whose words never reach the
    // drafted title or the provider.
    for (let i = 0; i < 10; i++) {
      f.signal(`Deprecation windows for the public API, step ${i}`, { session: `s${i % 2}` });
    }
    f.signal("PRIVATE-TEXT deprecation windows for the public API", {
      partition: "private",
      session: "s1",
    });
    const fake = new FakeDecisionProvider({});
    await ask(f, "topic_new:shadow", fake);
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests)).not.toContain("PRIVATE-TEXT");
    expect(refused("topic-new")).toEqual([]);
  });

  test("a word only inside a <private> region never reaches a drafted title, goal or the provider", async () => {
    // Private records of topic_new may go to the hosted provider here, so
    // the drafted title is sent; the region's word must not be in it.
    for (let i = 0; i < 5; i++) {
      f.signal(`<private>Zephyrquill</private> deprecation windows for the public API, step ${i}`, {
        session: `s${i % 2}`,
      });
    }
    f.tune("topic_new", { veto_below: 0.3 });
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("new_") ? 0.9 : undefined),
    });
    await ask(f, "topic_new:enforce", fake, {
      OPEN_SECOND_BRAIN_DECISION_MODEL_PRIVATE_USES: "topic_new",
    });
    expect(fake.requests).toHaveLength(1);
    const state = fake.requests[0]!.state as { title: string };
    expect(state.title).not.toBe("");
    expect(JSON.stringify(fake.requests).toLowerCase()).not.toContain("zephyrquill");
    planAndWord(f, {
      title: "Public API deprecation windows",
      goal: "Plan the deprecation steps.",
    });
    const stored = readPartition(join(f.m.root("dev-a"), "private"))
      .concat(readPartition(join(f.m.root("dev-a"), "shared")))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === TOPIC_CREATE_KIND && r.agent !== "seed");
    expect(stored).toHaveLength(1);
    const body = JSON.stringify(stored[0]!.body).toLowerCase();
    expect(body).not.toContain("zephyrquill");
    expect(body).not.toContain("***private***");
  });
});
