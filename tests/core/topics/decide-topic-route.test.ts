/**
 * `topic_route` as a queue item (change `dream-closed-questions`; was the
 * decide pass, task 4.1, design D10): `off` sends nothing and records
 * nothing, and the item waits; `shadow` sends and records, the item waits
 * and nothing is applied; `enforce` routes to the topic the model chose
 * (the assign carries `authority: "model"` and the verdict) and a model
 * `none` leaves the record free for grouping; below the threshold the
 * item abstains and on a timeout it waits with a retry time, nothing
 * applied either way; a blocked topic is never offered.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { TOPIC_ASSIGN_KIND } from "../../../src/core/topics/constants.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { answerClosedQuestions } from "../../helpers/closed-answers.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import { ask, plan } from "./fixtures/closed-run.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function route(
  choice: string,
  probability = 0.9,
  extra: { model?: string; fail?: "timeout" } = {},
) {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("route_") ? choice : undefined),
    probability,
    ...extra,
  });
}

/** The assigns written so far: the target topic id and the body's JSON. */
function assigns(): Array<{ topic: string; body: string }> {
  return readPartition(join(f.m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === TOPIC_ASSIGN_KIND)
    .map((r) => ({ topic: r.topic ?? "", body: JSON.stringify(r.body) }));
}

describe("topic_route on the queue", () => {
  test("off sends nothing, records nothing, and the item waits with nothing applied", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.seedTopic("Garden watering schedule for the alley beds");
    f.signal("Shard compaction thresholds were tuned today");
    const fake = route("T1", 0.95);
    await ask(f, "topic_route:off", fake);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(f.vault)).toEqual([]);
    const report = plan(f);
    expect(report.status === "planned" && report.routed).toEqual([]);
    expect(assigns()).toEqual([]);
    expect(f.items("topic-route").map((i) => i.state)).toEqual(["waiting"]);
  });

  test("shadow sends one request, records it, and the item waits with nothing applied", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.seedTopic("Garden watering schedule for the alley beds");
    f.signal("Shard compaction and garden watering schedules were tuned today");
    // The model chooses the garden topic; shadow must not act on it.
    const fake = route("T1", 0.95, { model: "shadow-model-7" });
    await ask(f, "topic_route:shadow", fake);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("topic_route");
    const state = fake.requests[0]!.state as {
      records: Record<string, string>;
      topics: Record<string, unknown>;
    };
    expect(Object.keys(state.records)).toEqual(["R0"]);
    expect(Object.keys(state.topics)).toEqual(["T0", "T1"]);
    const calls = listDecisionModelCalls(f.vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(calls[0]!.payload["use"]).toBe("topic_route");
    // Details are identifiers and numbers, spread into the record payload.
    const [item] = f.items("topic-route");
    expect(JSON.stringify(calls[0]!.payload)).toContain(item!.id);
    expect(calls[0]!.payload["chosen"]).toEqual(["T1"]);
    plan(f);
    expect(assigns()).toEqual([]);
    expect(f.items("topic-route")[0]!.state).toBe("waiting");
  });

  test("enforce routes to the topic the model chose; the assign carries the verdict", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTopic = f.seedTopic("Garden watering schedule for the alley beds");
    f.signal("Shard compaction and garden watering schedules were tuned today");
    f.tune("topic_route", { route_min: 0.6 });
    await ask(f, "topic_route:enforce", route("T1", 0.9, { model: "enforce-model-3" }));
    const report = plan(f);
    expect(report.status).toBe("planned");
    const written = assigns();
    expect(written).toHaveLength(1);
    expect(written[0]!.topic).toBe(gardenTopic);
    expect(JSON.parse(written[0]!.body)).toMatchObject({
      authority: "model",
      verdict: {
        use: "topic_route",
        model: "enforce-model-3",
        provider: "compatible",
        mode: "enforce",
        version: 2,
        confidence: 0.9,
      },
    });
  });

  test("below the threshold the item abstains and on a timeout it waits; nothing is routed", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.seedTopic("Garden watering schedule for the alley beds");
    f.signal("Shard compaction thresholds were tuned today");
    f.tune("topic_route", { route_min: 0.6 });
    // The timeout first: a failed attempt, the item waits with a retry time.
    const timeoutProvider = route("T0", 0.9, { fail: "timeout" });
    await ask(f, "topic_route:enforce", timeoutProvider);
    expect(timeoutProvider.requests).toHaveLength(1);
    const [waiting] = f.items("topic-route");
    expect(waiting!.state).toBe("waiting");
    expect(waiting!.attempts).toBe(1);
    expect(waiting!.retry_at).not.toBe(null);
    plan(f);
    expect(assigns()).toEqual([]);
    // After the retry time, an answer below the threshold abstains.
    f.setClock(Date.parse(waiting!.retry_at!) + 1000);
    const lowProvider = route("T0", 0.5);
    await ask(f, "topic_route:enforce", lowProvider);
    expect(lowProvider.requests).toHaveLength(1);
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(1);
    expect(assigns()).toEqual([]);
  });

  test("a blocked topic is never offered as an option", async () => {
    const shardTopic = f.seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTopic = f.seedTopic("Garden watering schedule for the alley beds");
    const r1 = f.signal("Shard compaction and garden watering schedules were tuned today");
    appendRecord(
      f.a,
      {
        partition: "shared",
        stream: "topics",
        kind: "unassign",
        agent: "seed",
        topic: shardTopic,
        body: { authority: "agent", record: r1 },
      },
      { now: f.now },
    );
    const fake = route("T0", 0.95);
    await ask(f, "topic_route:shadow", fake);
    expect(fake.requests).toHaveLength(1);
    const state = fake.requests[0]!.state as { topics: Record<string, unknown> };
    expect(Object.keys(state.topics)).toEqual(["T0"]);
    // And the item's options never name the blocked topic, so no answer can route there.
    expect(f.items("topic-route")[0]!.body.answer_schema["options"]).toEqual([gardenTopic, "none"]);
    f.tune("topic_route", { route_min: 0.6 });
    await ask(f, "topic_route:enforce", route("T0", 0.95));
    plan(f);
    expect(assigns()).toHaveLength(1);
    expect(assigns()[0]!.topic).toBe(gardenTopic);
  });

  test("a model none answer above the threshold leaves the record free for grouping", async () => {
    // The ranking offers this topic to every record.
    f.seedTopic("Alley garden beds watering");
    const records = [
      f.signal("Alley garden beds watering notes from meeting one", { session: "s1" }),
      f.signal("Alley garden beds watering notes from meeting two", { session: "s1" }),
      f.signal("Alley garden beds watering notes from meeting three", { session: "s2" }),
      f.signal("Alley garden beds watering notes from meeting four", { session: "s2" }),
      f.signal("Alley garden beds watering notes from meeting five", { session: "s2" }),
    ];
    f.tune("topic_route", { route_min: 0.6 });
    const fake = route("none");
    await ask(f, "topic_route:enforce", fake);
    expect(fake.requests.filter((req) => req.use === "topic_route")).toHaveLength(records.length);
    const report = plan(f);
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.routed).toEqual([]);
    for (const item of f.items("topic-route")) expect(item.applied?.effects).toEqual(["none"]);
    // The records stay free: the group qualifies and, approved, the topic is created.
    answerClosedQuestions(f.a, (item) => (item.operation === "topic-new" ? { p: 1 } : null), {
      now: f.still,
    });
    const next = plan(f);
    expect(next.status === "planned" && next.created).toHaveLength(1);
    if (next.status !== "planned") return;
    expect(next.created[0]!.title.toLowerCase()).toContain("garden");
  });
});

describe("a none route on later passes", () => {
  test("an enforce none is not asked again and still keeps the record off the topic", async () => {
    const shard = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.signal("Shard compaction of monthly shard files ran long today");
    f.tune("topic_route", { route_min: 0.6 });
    const first = route("none");
    await ask(f, "topic_route:enforce", first);
    expect(first.requests).toHaveLength(1);
    plan(f);
    const second = route("T0");
    await ask(f, "topic_route:enforce", second);
    expect(second.requests).toEqual([]);
    const report = plan(f);
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.routed.map((r) => r.topic)).not.toContain(shard);
  });
});

describe("route_min from the thresholds store", () => {
  test("a stored route_min above the answer decides, not the built-in default", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.seedTopic("Garden watering schedule for the alley beds");
    f.signal("Shard compaction and garden watering schedules were tuned today");
    f.tune("topic_route", { route_min: 0.95 });
    await ask(f, "topic_route:enforce", route("T1", 0.9));
    // The built-in 0.6 would route at 0.9; the stored 0.95 decides.
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(1);
    expect(assigns()).toEqual([]);
  });
});
