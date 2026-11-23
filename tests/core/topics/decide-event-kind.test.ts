/**
 * `event_kind` as queue items, one per held record (change
 * `dream-closed-questions`; was the decide pass, task 4.1, design D10):
 * `off` sends nothing; `shadow` records the call, the item waits and no
 * item record appears; `enforce` derives one item record per held record
 * - the item id equal to the record id, `authority: "model"`, the
 * `verdict` and the `source` - so a second pass writes nothing; below the
 * threshold and a routine answer abstain, a timeout waits; nothing is
 * written for any of them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { estimateTokens } from "../../../src/core/decision-model/state.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { TOPIC_SPLIT_KIND, TOPIC_UNASSIGN_KIND } from "../../../src/core/topics/constants.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import { ask, plan } from "./fixtures/closed-run.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function kind(
  answer: string,
  probability = 0.9,
  extra: { model?: string; fail?: "timeout" } = {},
): FakeDecisionProvider {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("kind_") ? answer : undefined),
    probability,
    ...extra,
  });
}

/** The topic records written so far, by kind. */
function recordsOfKind(k: string): Array<Record<string, unknown>> {
  return readPartition(join(f.m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === k)
    .map((r) => r.body);
}

function foldNow() {
  const records = readPartition(join(f.m.root("dev-a"), "shared")).flatMap((s) => s.records);
  return foldTopics(records);
}

function derived(report: ReturnType<typeof plan>): number {
  return report.status === "planned" ? report.derived : -1;
}

describe("event_kind on the queue", () => {
  test("the topic titles count toward the state budget", async () => {
    const topic = f.seedTopic(
      "Shard compaction keeps monthly shard files small. ".padEnd(200, "t"),
    );
    for (let i = 0; i < 10; i++) {
      const record = f.signal(`Shard compaction note ${i} about the threshold. `.padEnd(400, "r"));
      f.holdRecord(topic, record);
    }
    const maxStateTokens = 700;
    const fake = new FakeDecisionProvider({});
    await ask(f, "event_kind:shadow", fake, {
      OPEN_SECOND_BRAIN_DECISION_MODEL_MAX_STATE_TOKENS: String(maxStateTokens),
    });
    const kinds = fake.requests.filter((r) => r.use === "event_kind");
    expect(kinds).toHaveLength(10);
    for (const request of kinds) {
      expect(
        estimateTokens({ state: request.state, questions: request.questions }),
      ).toBeLessThanOrEqual(maxStateTokens);
      // Every record still carries its topic's title.
      const records = Object.values(
        (request.state as { records: Record<string, { topic: string }> }).records,
      );
      expect(records.every((r) => r.topic.startsWith("Shard compaction keeps"))).toBe(true);
    }
  });

  test("a new held record never starves behind old routine ones", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 60; i++) f.holdRecord(topic, f.signal(`routine heartbeat ${i}`));
    await ask(f, "event_kind:shadow", kind("routine"));
    const fresh = f.signal("Shard compaction decision: thresholds ship next week");
    f.holdRecord(topic, fresh);
    const next = kind("routine");
    await ask(f, "event_kind:shadow", next);
    // The old items were asked in shadow for their input: only the new one is asked.
    const texts = next.requests.flatMap((r) =>
      Object.values((r.state as { records: Record<string, { text: string }> }).records).map(
        (rec) => rec.text,
      ),
    );
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("thresholds ship next week");
  }, 30_000);

  test("each record is asked in a request of its own, named in its question", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    for (const text of ["first held note", "second held note", "third held note"]) {
      f.holdRecord(topic, f.signal(text));
    }
    const fake = kind("routine");
    await ask(f, "event_kind:shadow", fake);
    expect(fake.requests).toHaveLength(3);
    for (const request of fake.requests) {
      const questions = request.questions as Record<string, { instructions: unknown }>;
      expect(Object.keys(questions)).toEqual(["kind_0"]);
      expect(String(questions["kind_0"]!.instructions)).toContain("`records.R0`");
    }
  });

  test("off sends nothing and writes no item", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.holdRecord(topic, f.signal("Shard compaction decision: thresholds ship next week"));
    const fake = kind("decision");
    await ask(f, "event_kind:off", fake);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(f.vault)).toEqual([]);
    expect(derived(plan(f))).toBe(0);
    expect(recordsOfKind("decision")).toEqual([]);
    expect(f.items("event-kind").map((i) => i.state)).toEqual(["waiting"]);
  });

  test("shadow asks once, records, and no item appears", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.holdRecord(topic, f.signal("Shard compaction decision: thresholds ship next week"));
    const fake = kind("decision", 0.9, { model: "shadow-model-9" });
    await ask(f, "event_kind:shadow", fake);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("event_kind");
    const state = fake.requests[0]!.state as {
      records: Record<string, { topic: string; text: string }>;
    };
    expect(state.records["R0"]!.topic).toBe("Shard compaction keeps monthly shard files small");
    expect(state.records["R0"]!.text).toContain("decision");
    const calls = listDecisionModelCalls(f.vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(calls[0]!.payload["use"]).toBe("event_kind");
    expect(derived(plan(f))).toBe(0);
    expect(recordsOfKind("decision")).toEqual([]);
  });

  test("enforce derives a decision item carrying the verdict and the source", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = f.signal("Shard compaction decision: thresholds ship next week");
    f.holdRecord(topic, r1);
    f.tune("event_kind", { kind_min: 0.7 });
    await ask(f, "event_kind:enforce", kind("decision", 0.9, { model: "kind-model-1" }));
    expect(derived(plan(f))).toBe(1);
    const items = recordsOfKind("decision");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      authority: "model",
      item: r1,
      source: r1,
      text: "Shard compaction decision: thresholds ship next week",
      verdict: {
        use: "event_kind",
        model: "kind-model-1",
        mode: "enforce",
        version: 2,
        confidence: 0.9,
      },
    });
    // The fold holds the item on the topic.
    expect(
      foldNow()
        .topics.get(topic)
        ?.items.some((item) => item.id === r1),
    ).toBe(true);
  });

  test("a record taken out of one topic and routed to another by a model gets no item there", async () => {
    const away = f.seedTopic("Release notes formatting for the changelog");
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = f.signal("Shard compaction decision: thresholds ship next week");
    f.holdRecord(away, r1);
    // A person takes the record back out: the fold holds an explicit none.
    appendRecord(
      f.a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_UNASSIGN_KIND,
        agent: "seed",
        topic: away,
        body: { authority: "human", record: r1 },
      },
      { now: f.now },
    );
    f.tune("event_kind", { kind_min: 0.7 });
    f.tune("topic_route", { route_min: 0.6 });
    const fake = new FakeDecisionProvider({
      answer: (id) =>
        id.startsWith("route_") ? "T0" : id.startsWith("kind_") ? "decision" : undefined,
      probability: 0.9,
    });
    const uses = "topic_route:enforce,event_kind:enforce";
    await ask(f, uses, fake);
    const routed = plan(f);
    expect(routed.status === "planned" ? routed.routed : []).toEqual([
      expect.objectContaining({ record: r1, topic }) as never,
    ]);
    // The person's explicit none outranks the model's route in the fold:
    // no topic holds the record, so its kind is never asked and no item
    // is derived (the decide pass derived one from its in-memory verdict).
    await ask(f, uses, fake);
    expect(fake.requests.filter((r) => r.use === "event_kind")).toEqual([]);
    expect(derived(plan(f))).toBe(0);
    expect(
      foldNow()
        .topics.get(topic)
        ?.items.some((item) => item.id === r1),
    ).toBe(false);
  });

  test("a second pass writes no second item", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.holdRecord(topic, f.signal("Shard compaction decision: thresholds ship next week"));
    f.tune("event_kind", { kind_min: 0.7 });
    const fake = kind("decision");
    await ask(f, "event_kind:enforce", fake);
    expect(plan(f).status).toBe("planned");
    expect(recordsOfKind("decision")).toHaveLength(1);
    // Second pass: the item exists, so nothing is asked about it.
    fake.requests.length = 0;
    await ask(f, "event_kind:enforce", fake);
    expect(fake.requests).toEqual([]);
    expect(derived(plan(f))).toBe(0);
    expect(recordsOfKind("decision")).toHaveLength(1);
  });

  test("a log-class answer writes a log-entry with the class; routine writes nothing", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = f.signal("Shard compaction blocker: the shard writer stalls");
    f.holdRecord(topic, r1);
    f.tune("event_kind", { kind_min: 0.7 });
    await ask(f, "event_kind:enforce", kind("blocker"));
    expect(plan(f).status).toBe("planned");
    const entries = recordsOfKind("log-entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      authority: "model",
      class: "blocker",
      item: r1,
      source: r1,
    });
  });

  test("below the threshold and a routine answer abstain, a timeout waits; nothing is written", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.holdRecord(topic, f.signal("Shard compaction decision: thresholds ship next week"));
    f.tune("event_kind", { kind_min: 0.7 });
    // A timeout: a failed attempt, the item waits with a retry time.
    const timeoutProvider = kind("decision", 0.9, { fail: "timeout" });
    await ask(f, "event_kind:enforce", timeoutProvider);
    expect(timeoutProvider.requests).toHaveLength(1);
    const [waiting] = f.items("event-kind");
    expect(waiting!.attempts).toBe(1);
    expect(derived(plan(f))).toBe(0);
    // After the retry time, below the threshold: the item abstains.
    f.setClock(Date.parse(waiting!.retry_at!) + 1000);
    const lowProvider = kind("decision", 0.5);
    await ask(f, "event_kind:enforce", lowProvider);
    expect(lowProvider.requests).toHaveLength(1);
    const low = plan(f);
    expect(low.status === "planned" && low.abstained).toBe(1);
    // The abstained record is not asked again: the routine case is a record of its own.
    f.holdRecord(topic, f.signal("Shard compaction routine: reran the nightly job"));
    const routineProvider = kind("routine", 0.95);
    await ask(f, "event_kind:enforce", routineProvider);
    expect(routineProvider.requests).toHaveLength(1);
    expect(JSON.stringify(routineProvider.requests[0]!.state)).toContain("nightly job");
    expect(JSON.stringify(routineProvider.requests[0]!.state)).not.toContain("ship next week");
    const routine = plan(f);
    expect(routine.status === "planned" && routine.abstained).toBe(1);
    expect(recordsOfKind("decision")).toEqual([]);
    expect(recordsOfKind("log-entry")).toEqual([]);
  });

  test("a record no topic holds and no answer routes is never asked about", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    // No project: the planner never routes it and never groups it.
    f.signal("A personal note on the greenhouse humidity log", { project: null });
    const fake = new FakeDecisionProvider({});
    await ask(f, "event_kind:shadow", fake);
    expect(fake.requests).toEqual([]);
  });

  test("a record is asked about once a route answer holds it, not before", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.signal("Shard compaction decision: thresholds ship next week");
    f.tune("topic_route", { route_min: 0.6 });
    const fake = new FakeDecisionProvider({
      answer: (id) =>
        id.startsWith("route_") ? "T0" : id.startsWith("kind_") ? "decision" : undefined,
      probability: 0.9,
    });
    const uses = "topic_route:enforce,event_kind:shadow";
    await ask(f, uses, fake);
    expect(fake.requests.filter((r) => r.use === "event_kind")).toEqual([]);
    plan(f);
    await ask(f, uses, fake);
    expect(fake.requests.filter((r) => r.use === "event_kind")).toHaveLength(1);
    expect(plan(f).status).toBe("planned");
    // Shadow never derives the item.
    expect(recordsOfKind("decision")).toEqual([]);
  });
});

describe("event_kind after a model route", () => {
  test("a record the model routed elsewhere is asked about under the topic it chose", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTitle = "Garden watering schedule for the alley beds";
    const garden = f.seedTopic(gardenTitle);
    // The word-overlap rule ranks the compaction topic first for this record.
    const r1 = f.signal("Shard compaction and garden watering schedules were tuned today");
    f.tune("event_kind", { kind_min: 0.7 });
    f.tune("topic_route", { route_min: 0.6 });
    const fake = new FakeDecisionProvider({
      answer: (id) =>
        id.startsWith("route_") ? "T1" : id.startsWith("kind_") ? "decision" : undefined,
      probability: 0.9,
    });
    const uses = "topic_route:enforce,event_kind:enforce";
    await ask(f, uses, fake);
    plan(f);
    await ask(f, uses, fake);
    const kindRequest = fake.requests.find((r) => r.use === "event_kind");
    const state = kindRequest?.state as { records: Record<string, { topic: string }> };
    expect(state.records["R0"]?.topic).toBe(gardenTitle);
    expect(derived(plan(f))).toBe(1);
    expect(
      foldNow()
        .topics.get(garden)
        ?.items.some((item) => item.id === r1),
    ).toBe(true);
  });
});

describe("event_kind after a split", () => {
  test("a record whose derived item a split moved away is not asked about again", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    const other = f.seedTopic("Garden watering schedule for the alley beds");
    const r1 = f.signal("Shard compaction decision: thresholds ship next week");
    f.holdRecord(topic, r1);
    const topicRecord = (k: string, body: Record<string, unknown>): void => {
      appendRecord(
        f.a,
        { partition: "shared", stream: "topics", kind: k, agent: "seed", topic, body },
        { now: f.now },
      );
    };
    f.tune("event_kind", { kind_min: 0.7 });
    const fake = kind("decision");
    // An answer accepted before the move: the write under the lock skips it.
    await ask(f, "event_kind:enforce", fake);
    expect(f.items("event-kind")[0]!.state).toBe("accepted");
    // The item derived from r1, then moved to the other topic by a split
    // that leaves the record itself where it was.
    topicRecord("decision", { authority: "model", item: r1, text: "derived", source: r1 });
    topicRecord(TOPIC_SPLIT_KIND, { authority: "human", into: other, items: [r1] });
    expect(foldNow().movedAway(topic, r1)).toBe(true);
    expect(derived(plan(f))).toBe(0);
    // A pass after the move does not ask about the record again.
    const asked = fake.requests.length;
    await ask(f, "event_kind:enforce", fake);
    expect(fake.requests).toHaveLength(asked);
  });
});

describe("kind_min from the thresholds store", () => {
  test("a stored kind_min above the answer decides, not the built-in default", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.holdRecord(topic, f.signal("Shard compaction decision: thresholds ship next week"));
    f.tune("event_kind", { kind_min: 0.95 });
    await ask(f, "event_kind:enforce", kind("decision"));
    // The built-in 0.7 would accept 0.9; the stored 0.95 decides.
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(1);
    expect(recordsOfKind("decision")).toEqual([]);
  });
});
