/**
 * `topic_route` in the decide pass (task 4.1, design D10): `off` sends
 * nothing and records nothing; `shadow` sends and records but the
 * deterministic route stands; `enforce` routes to the topic the model
 * chose (the assign carries `authority: "model"` and the verdict) and a
 * model `none` leaves the record free for grouping; below threshold or
 * on a timeout the fallback stands; a blocked topic is never offered.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  resetThresholdsStoreCache,
  writeThresholdEntry,
  decisionThresholdsPath,
} from "../../../src/core/decision-model/thresholds.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { TOPIC_ASSIGN_KIND, TOPIC_CREATE_KIND } from "../../../src/core/topics/constants.ts";
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
import { emptyTopicVerdicts } from "../../../src/core/topics/verdicts.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);
let clock = T0;
const now = () => (clock += 1000);

let m: Machines;
let a: StoreHandle;
let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-decide-route-");
  a = m.open("dev-a");
  claimViewWriter(a, { agent: "dream", now });
  claimSettled(a, readViewWriter(a, now));
  tmp = mkdtempSync(join(m.parent, "cfg-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  process.env["VAULT_DIR"] = vault;
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, "");
  resetThresholdsStoreCache();
});

afterEach(() => {
  delete process.env["VAULT_DIR"];
  resetThresholdsStoreCache();
  m.cleanup();
});

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
        id: `sig-2026-12-01-r${seq}`,
        path: `Brain/inbox/r${seq}.md`,
        staged: false,
        frontmatter: { principle: text, project: "o2b", session },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now },
  ).record.id;
}

function seedTopic(title: string): string {
  clock += 1000;
  const topic = newUlid(clock);
  appendRecord(
    a,
    {
      partition: "shared",
      stream: "topics",
      kind: TOPIC_CREATE_KIND,
      agent: "seed",
      topic,
      body: { authority: "agent", title, scope: "project:o2b" },
    },
    { now },
  );
  return topic;
}

function envFor(mode: string): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `topic_route:${mode}`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

function tuneForEnforce(value = 0.6): void {
  writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "topic_route", {
    values: { route_min: value },
    source: "set",
  });
  resetThresholdsStoreCache();
}

/** The assigns written so far: the target topic id and the body's JSON. */
function assigns(): Array<{ topic: string; body: string }> {
  return readPartition(join(m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === TOPIC_ASSIGN_KIND)
    .map((r) => ({ topic: r.topic ?? "", body: JSON.stringify(r.body) }));
}

describe("topic_route in the decide pass", () => {
  test("off sends nothing, records nothing, and planning is the deterministic one", async () => {
    const shardTopic = seedTopic("Shard compaction keeps monthly shard files small");
    seedTopic("Garden watering schedule for the alley beds");
    signal("Shard compaction thresholds were tuned today");
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "T1" : undefined),
      probability: 0.95,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("off"), now });
    expect([...verdicts.routes.keys()]).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(vault)).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.routed).toHaveLength(1);
    const written = assigns();
    expect(written).toHaveLength(1);
    expect(written[0]!.body).not.toContain("verdict");
    expect(written[0]!.topic).toBe(shardTopic);
  });

  test("shadow sends one request, records it, and the deterministic route stands", async () => {
    const shardTopic = seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTopic = seedTopic("Garden watering schedule for the alley beds");
    const r1 = signal("Shard compaction and garden watering schedules were tuned today");
    // The model chooses the garden topic; shadow must not act on it.
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "T1" : undefined),
      probability: 0.95,
      model: "shadow-model-7",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect([...verdicts.routes.keys()]).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("topic_route");
    const state = fake.requests[0]!.state as {
      records: Record<string, string>;
      topics: Record<string, unknown>;
    };
    expect(Object.keys(state.records)).toEqual(["R0"]);
    expect(Object.keys(state.topics)).toEqual(["T0", "T1"]);
    const calls = listDecisionModelCalls(vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(calls[0]!.payload["use"]).toBe("topic_route");
    // Details are identifiers and numbers, spread into the record payload.
    expect(JSON.stringify(calls[0]!.payload)).toContain(r1);
    expect(calls[0]!.payload["chosen"]).toEqual(["T1"]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    const written = assigns();
    expect(written).toHaveLength(1);
    expect(written[0]!.topic).toBe(shardTopic);
    expect(written[0]!.body).not.toContain("verdict");
    void gardenTopic;
  });

  test("enforce routes to the topic the model chose; the assign carries the verdict", async () => {
    seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTopic = seedTopic("Garden watering schedule for the alley beds");
    const r1 = signal("Shard compaction and garden watering schedules were tuned today");
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "T1" : undefined),
      probability: 0.9,
      model: "enforce-model-3",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    const route = verdicts.routes.get(r1);
    expect(route?.topic).toBe(gardenTopic);
    expect(route?.verdict).toEqual({
      use: "topic_route",
      model: "enforce-model-3",
      provider: "compatible",
      version: 2,
      mode: "enforce",
      confidence: 0.9,
    });
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    const written = assigns();
    expect(written).toHaveLength(1);
    expect(written[0]!.topic).toBe(gardenTopic);
    expect(JSON.parse(written[0]!.body)).toMatchObject({
      authority: "model",
      verdict: {
        use: "topic_route",
        model: "enforce-model-3",
        mode: "enforce",
        version: 2,
        confidence: 0.9,
      },
    });
  });

  test("below the threshold and on a timeout the deterministic route stands", async () => {
    const shardTopic = seedTopic("Shard compaction keeps monthly shard files small");
    seedTopic("Garden watering schedule for the alley beds");
    signal("Shard compaction thresholds were tuned today");
    tuneForEnforce();
    // The timeout first: a timeout enters nothing in the asked set, so the
    // record is still asked below; an answer below the threshold would be
    // entered and never asked again.
    const timeoutProvider = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "T1" : undefined),
      probability: 0.9,
      fail: "timeout",
    });
    const timedOut = await decideTopicPlan(a, {
      provider: timeoutProvider,
      env: envFor("enforce"),
      now,
    });
    expect(timeoutProvider.requests).toHaveLength(1);
    expect([...timedOut.routes.keys()]).toEqual([]);
    const lowProvider = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "T1" : undefined),
      probability: 0.5,
    });
    const low = await decideTopicPlan(a, { provider: lowProvider, env: envFor("enforce"), now });
    expect(lowProvider.requests).toHaveLength(1);
    expect([...low.routes.keys()]).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: low });
    expect(report.status).toBe("planned");
    expect(assigns()[0]!.topic).toBe(shardTopic);
    expect(assigns()[0]!.body).not.toContain("verdict");
  });

  test("a blocked topic is never offered as an option", async () => {
    const shardTopic = seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTopic = seedTopic("Garden watering schedule for the alley beds");
    const r1 = signal("Shard compaction and garden watering schedules were tuned today");
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "topics",
        kind: "unassign",
        agent: "seed",
        topic: shardTopic,
        body: { authority: "agent", record: r1 },
      },
      { now },
    );
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "T0" : undefined),
      probability: 0.95,
    });
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(fake.requests).toHaveLength(1);
    const state = fake.requests[0]!.state as { topics: Record<string, unknown> };
    expect(Object.keys(state.topics)).toEqual(["T0"]);
    // And a verdict onto the blocked topic would be ignored by the plan.
    const report = runTopicPlanning(a, {
      agent: "dream",
      now,
      topicVerdicts: {
        ...emptyTopicVerdicts(),
        routes: new Map([
          [
            r1,
            {
              topic: shardTopic,
              privateInput: false,
              verdict: {
                use: "topic_route",
                model: "m",
                provider: "p",
                version: 1,
                mode: "enforce",
                confidence: 0.99,
              },
            },
          ],
        ]),
      },
    });
    expect(report.status).toBe("planned");
    expect(assigns()).toHaveLength(1);
    expect(assigns()[0]!.topic).toBe(gardenTopic);
  });

  test("a model none answer above the threshold leaves the record free for grouping", async () => {
    // The deterministic ranking routes every record to this topic.
    seedTopic("Alley garden beds watering");
    const records = [
      signal("Alley garden beds watering notes from meeting one", "s1"),
      signal("Alley garden beds watering notes from meeting two", "s1"),
      signal("Alley garden beds watering notes from meeting three", "s2"),
      signal("Alley garden beds watering notes from meeting four", "s2"),
      signal("Alley garden beds watering notes from meeting five", "s2"),
    ];
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "none" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(fake.requests.some((req) => req.use === "topic_route")).toBe(true);
    expect([...verdicts.routes.keys()].toSorted()).toEqual(records.toSorted());
    for (const entry of verdicts.routes.values()) expect(entry.topic).toBe(null);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.routed).toEqual([]);
    // The records stay free: the group qualifies and the topic is created.
    expect(report.created).toHaveLength(1);
    const created = report.created[0]!;
    expect(created.title.toLowerCase()).toContain("garden");
  });
});

describe("a none route on later passes", () => {
  test("an enforce none is not asked again and still keeps the record off the topic", async () => {
    const shard = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction of monthly shard files ran long today");
    tuneForEnforce();
    const first = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "none" : undefined),
      probability: 0.9,
    });
    await decideTopicPlan(a, { provider: first, env: envFor("enforce"), now });
    expect(first.requests).toHaveLength(1);
    const second = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "T0" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: second, env: envFor("enforce"), now });
    expect(second.requests).toEqual([]);
    expect(verdicts.routes.get(r1)?.topic).toBe(null);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.routed.map((r) => r.topic)).not.toContain(shard);
  });
});

describe("route_min from the thresholds store", () => {
  test("a stored route_min above the answer decides, not the built-in default", async () => {
    seedTopic("Shard compaction keeps monthly shard files small");
    seedTopic("Garden watering schedule for the alley beds");
    const r1 = signal("Shard compaction and garden watering schedules were tuned today");
    tuneForEnforce(0.95);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("route_") ? "T1" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    // The built-in 0.6 would route at 0.9; the stored 0.95 decides.
    expect(verdicts.routes.get(r1)).toBeUndefined();
  });
});
