/**
 * `event_kind` in the decide pass (task 4.1, design D10): `off` sends
 * nothing; `shadow` records the call without effect; `enforce` derives
 * one item record per held record - the item id equal to the record id,
 * `authority: "model"`, the `verdict` and the `source` - so a second
 * pass writes nothing; below the threshold, a timeout and a routine
 * answer keep today's behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import {
  QUESTION_TOKEN_ALLOWANCE,
  estimateTokens,
} from "../../../src/core/decision-model/state.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_UNASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_SPLIT_KIND,
} from "../../../src/core/topics/constants.ts";
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
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
  m = makeMachines(["dev-a"], "o2b-decide-kind-");
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
function signal(text: string, session = "s1", project: string | null = "o2b"): string {
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
        id: `sig-2026-12-01-k${seq}`,
        path: `Brain/inbox/k${seq}.md`,
        staged: false,
        frontmatter: {
          principle: text,
          ...(project !== null ? { project } : {}),
          session,
        },
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

function holdRecord(topic: string, record: string): void {
  appendRecord(
    a,
    {
      partition: "shared",
      stream: "topics",
      kind: TOPIC_ASSIGN_KIND,
      agent: "seed",
      topic,
      body: { authority: "agent", record },
    },
    { now },
  );
}

function envFor(mode: string): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `event_kind:${mode}`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

function tuneForEnforce(value = 0.7): void {
  writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "event_kind", {
    values: { kind_min: value },
    source: "set",
  });
  resetThresholdsStoreCache();
}

/** The topic records written so far, by kind. */
function recordsOfKind(kind: string): Array<Record<string, unknown>> {
  return readPartition(join(m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === kind)
    .map((r) => r.body);
}

function foldNow() {
  const records = readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records);
  return foldTopics(records);
}

describe("event_kind in the decide pass", () => {
  test("the topic titles count toward the state budget", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small. ".padEnd(200, "t"));
    for (let i = 0; i < 10; i++) {
      const record = signal(`Shard compaction note ${i} about the threshold. `.padEnd(400, "r"));
      holdRecord(topic, record);
    }
    const maxStateTokens = 700;
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, {
      provider: fake,
      env: {
        ...envFor("shadow"),
        OPEN_SECOND_BRAIN_DECISION_MODEL_MAX_STATE_TOKENS: String(maxStateTokens),
      },
      now,
    });
    const kinds = fake.requests.filter((r) => r.use === "event_kind");
    expect(kinds.length).toBeGreaterThan(0);
    for (const request of kinds) {
      expect(estimateTokens(request.state) + QUESTION_TOKEN_ALLOWANCE).toBeLessThanOrEqual(
        maxStateTokens,
      );
      // Every record still carries its topic's title.
      const records = Object.values(
        (request.state as { records: Record<string, { topic: string }> }).records,
      );
      expect(records.every((r) => r.topic.startsWith("Shard compaction keeps"))).toBe(true);
    }
  });

  test("held records are asked newest first, so a new one never starves behind old routine ones", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 60; i++) holdRecord(topic, signal(`routine heartbeat ${i}`));
    const routine = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "routine" : undefined),
    });
    await decideTopicPlan(a, { provider: routine, env: envFor("shadow"), now });
    const fresh = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(topic, fresh);
    const next = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "routine" : undefined),
    });
    await decideTopicPlan(a, { provider: next, env: envFor("shadow"), now });
    const texts = next.requests.flatMap((r) =>
      Object.values((r.state as { records: Record<string, { text: string }> }).records).map(
        (rec) => rec.text,
      ),
    );
    expect(texts[0]).toContain("thresholds ship next week");
  });

  test("a batched request names each record in its own question", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    for (const text of ["first held note", "second held note", "third held note"]) {
      holdRecord(topic, signal(text));
    }
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "routine" : undefined),
    });
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(fake.requests).toHaveLength(1);
    const questions = fake.requests[0]!.questions as Record<string, { instructions: unknown }>;
    const texts = [0, 1, 2].map((k) => String(questions[`kind_${k}`]!.instructions));
    texts.forEach((text, k) => expect(text).toContain(`\`records.R${k}\``));
    expect(new Set(texts).size).toBe(3);
  });

  test("off sends nothing and writes no item", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(topic, r1);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("off"), now });
    expect([...verdicts.kinds.keys()]).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(vault)).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.derived).toBe(0);
    expect(recordsOfKind("decision")).toEqual([]);
  });

  test("shadow asks once, records, and no item appears", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(topic, r1);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
      model: "shadow-model-9",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect([...verdicts.kinds.keys()]).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("event_kind");
    const state = fake.requests[0]!.state as {
      records: Record<string, { topic: string; text: string }>;
    };
    expect(state.records["R0"]!.topic).toBe("Shard compaction keeps monthly shard files small");
    expect(state.records["R0"]!.text).toContain("decision");
    const calls = listDecisionModelCalls(vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(calls[0]!.payload["use"]).toBe("event_kind");
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.derived : -1).toBe(0);
    expect(recordsOfKind("decision")).toEqual([]);
    void topic;
  });

  test("enforce derives a decision item carrying the verdict and the source", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(topic, r1);
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
      model: "kind-model-1",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(verdicts.kinds.get(r1)?.kind).toBe("decision");
    expect(verdicts.kinds.get(r1)?.topic).toBe(topic);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.derived : -1).toBe(1);
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
    const fold = foldNow();
    expect(fold.topics.get(topic)?.items.some((item) => item.id === r1)).toBe(true);
  });

  test("a record taken out of one topic and routed to another this pass gets its item there", async () => {
    const away = seedTopic("Release notes formatting for the changelog");
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(away, r1);
    // A person takes the record back out: the fold holds an explicit none.
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_UNASSIGN_KIND,
        agent: "seed",
        topic: away,
        body: { authority: "human", record: r1 },
      },
      { now },
    );
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(verdicts.kinds.get(r1)?.topic).toBe(topic);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.routed : []).toEqual([
      expect.objectContaining({ record: r1, topic }) as never,
    ]);
    expect(report.status === "planned" ? report.derived : -1).toBe(1);
    expect(
      foldNow()
        .topics.get(topic)
        ?.items.some((item) => item.id === r1),
    ).toBe(true);
  });

  test("a second pass writes no second item", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(topic, r1);
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
    });
    const first = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(runTopicPlanning(a, { agent: "dream", now, topicVerdicts: first }).status).toBe(
      "planned",
    );
    expect(recordsOfKind("decision")).toHaveLength(1);
    // Second pass: the item exists, so nothing is asked about it.
    fake.requests.length = 0;
    const second = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect([...second.kinds.keys()]).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: second });
    expect(report.status === "planned" ? report.derived : -1).toBe(0);
    expect(recordsOfKind("decision")).toHaveLength(1);
  });

  test("a log-class answer writes a log-entry with the class; routine writes nothing", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction blocker: the shard writer stalls");
    holdRecord(topic, r1);
    tuneForEnforce();
    const blocker = await decideTopicPlan(a, {
      provider: new FakeDecisionProvider({
        answer: (id) => (id.startsWith("kind_") ? "blocker" : undefined),
        probability: 0.9,
      }),
      env: envFor("enforce"),
      now,
    });
    expect(runTopicPlanning(a, { agent: "dream", now, topicVerdicts: blocker }).status).toBe(
      "planned",
    );
    const entries = recordsOfKind("log-entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      authority: "model",
      class: "blocker",
      item: r1,
      source: r1,
    });
    void topic;
  });

  test("below the threshold, a timeout and a routine answer keep today's behaviour", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(topic, r1);
    tuneForEnforce();
    // A timeout enters nothing in the asked set: it goes first, on r1.
    const timeoutProvider = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
      fail: "timeout",
    });
    const timedOut = await decideTopicPlan(a, {
      provider: timeoutProvider,
      env: envFor("enforce"),
      now,
    });
    expect(timeoutProvider.requests).toHaveLength(1);
    expect([...timedOut.kinds.keys()]).toEqual([]);
    // Below the threshold, on r1 still unasked.
    const lowProvider = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.5,
    });
    const low = await decideTopicPlan(a, { provider: lowProvider, env: envFor("enforce"), now });
    expect(lowProvider.requests).toHaveLength(1);
    expect([...low.kinds.keys()]).toEqual([]);
    // r1 is now in the asked set: the routine case gets a record of its own.
    const r2 = signal("Shard compaction routine: reran the nightly job");
    holdRecord(topic, r2);
    const routineProvider = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "routine" : undefined),
      probability: 0.95,
    });
    const routine = await decideTopicPlan(a, {
      provider: routineProvider,
      env: envFor("enforce"),
      now,
    });
    expect(routineProvider.requests).toHaveLength(1);
    expect(JSON.stringify(routineProvider.requests[0]!.state)).toContain("nightly job");
    expect(JSON.stringify(routineProvider.requests[0]!.state)).not.toContain("ship next week");
    expect([...routine.kinds.keys()]).toEqual([]);
    expect(runTopicPlanning(a, { agent: "dream", now, topicVerdicts: routine }).status).toBe(
      "planned",
    );
    expect(recordsOfKind("decision")).toEqual([]);
    expect(recordsOfKind("log-entry")).toEqual([]);
  });

  test("a record no topic holds and no pass routes is never asked about", async () => {
    seedTopic("Shard compaction keeps monthly shard files small");
    // No project: the planner never routes it and never groups it.
    signal("A personal note on the greenhouse humidity log", "s1", null);
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(fake.requests).toEqual([]);
  });

  test("a record the pass routes deterministically is asked about (routed in this pass)", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(fake.requests).toHaveLength(1);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    // Shadow never derives the item.
    expect(recordsOfKind("decision")).toEqual([]);
    void topic;
    void r1;
  });
});

describe("event_kind after a model route", () => {
  test("a record the model routed elsewhere is asked about under the topic it chose", async () => {
    seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTitle = "Garden watering schedule for the alley beds";
    const garden = seedTopic(gardenTitle);
    // The word-overlap rule routes this record to the compaction topic.
    const r1 = signal("Shard compaction and garden watering schedules were tuned today");
    tuneForEnforce();
    writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "topic_route", {
      values: { route_min: 0.6 },
      source: "set",
    });
    resetThresholdsStoreCache();
    const fake = new FakeDecisionProvider({
      answer: (id) =>
        id.startsWith("route_") ? "T1" : id.startsWith("kind_") ? "decision" : undefined,
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: {
        ...envFor("enforce"),
        OPEN_SECOND_BRAIN_DECISION_MODEL_USES: "topic_route:enforce,event_kind:enforce",
      },
      now,
    });
    expect(verdicts.routes.get(r1)?.topic).toBe(garden);
    expect(verdicts.kinds.get(r1)?.topic).toBe(garden);
    const kindRequest = fake.requests.find((r) => r.use === "event_kind");
    const state = kindRequest?.state as { records: Record<string, { topic: string }> };
    expect(state.records["R0"]?.topic).toBe(gardenTitle);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.derived : -1).toBe(1);
    expect(
      foldNow()
        .topics.get(garden)
        ?.items.some((item) => item.id === r1),
    ).toBe(true);
  });
});

describe("event_kind after a split", () => {
  test("a record whose derived item a split moved away is not asked about again", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const other = seedTopic("Garden watering schedule for the alley beds");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(topic, r1);
    const topicRecord = (kind: string, body: Record<string, unknown>): void => {
      appendRecord(
        a,
        { partition: "shared", stream: "topics", kind, agent: "seed", topic, body },
        { now },
      );
    };
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
    });
    // A verdict decided before the move: the write under the lock skips it.
    const before = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(before.kinds.get(r1)?.topic).toBe(topic);
    // The item derived from r1, then moved to the other topic by a split
    // that leaves the record itself where it was.
    topicRecord("decision", { authority: "model", item: r1, text: "derived", source: r1 });
    topicRecord(TOPIC_SPLIT_KIND, { authority: "human", into: other, items: [r1] });
    expect(foldNow().movedAway(topic, r1)).toBe(true);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: before });
    expect(report.status === "planned" ? report.derived : -1).toBe(0);
    // A pass after the move does not ask about the record again.
    const asked = fake.requests.length;
    const after = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(fake.requests).toHaveLength(asked);
    expect(after.kinds.get(r1)).toBeUndefined();
  });
});

describe("kind_min from the thresholds store", () => {
  test("a stored kind_min above the answer decides, not the built-in default", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    const r1 = signal("Shard compaction decision: thresholds ship next week");
    holdRecord(topic, r1);
    tuneForEnforce(0.95);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    // The built-in 0.7 would accept 0.9; the stored 0.95 decides.
    expect(verdicts.kinds.get(r1)).toBeUndefined();
  });
});
