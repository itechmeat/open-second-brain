/**
 * The decide pass on the topic rules the planner holds (design D20):
 *
 *  - a proposal for an item a merged topic shows is written under the
 *    item's owner, so the fold finds it;
 *  - a private item, or a private head field of a shared topic, never
 *    reaches a hosted provider;
 *  - the history window follows the date the run is for;
 *  - a verdict write that fails part way still counts what landed.
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
import { newUlid } from "../../../src/core/store/ulid.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_MERGE_KIND,
  TOPIC_MILESTONE_KIND,
  TOPIC_QUESTION_KIND,
  TOPIC_RENAME_KIND,
} from "../../../src/core/topics/constants.ts";
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { writeVerdictRecords } from "../../../src/core/topics/verdict-writes.ts";
import { emptyTopicVerdicts, type TopicVerdictBody } from "../../../src/core/topics/verdicts.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";

const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let clock = T0;
const now = () => (clock += 1000);

let m: Machines;
let a: StoreHandle;
let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-decide-owner-");
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

function topicRecord(
  kind: string,
  topic: string,
  body: Record<string, unknown>,
  partition: "shared" | "private" = "shared",
): string {
  clock += 1000;
  return appendRecord(
    a,
    {
      partition,
      stream: "topics",
      kind,
      agent: "seed",
      topic,
      body: { authority: "agent", ...body },
    },
    { now },
  ).record.id;
}

function seedTopic(title: string): string {
  clock += 1000;
  const topic = newUlid(clock);
  topicRecord(TOPIC_CREATE_KIND, topic, { title, scope: "project:o2b" });
  return topic;
}

let seq = 0;
function signal(text: string, partition: "shared" | "private" = "shared", session = "s1"): string {
  clock += 1000;
  seq += 1;
  return appendRecord(
    a,
    {
      partition,
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: `sig-2026-12-01-p${seq}`,
        path: `Brain/inbox/p${seq}.md`,
        staged: false,
        frontmatter: { principle: text, project: "o2b", session },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now },
  ).record.id;
}

function note(text: string, ms: number): string {
  clock += 1000;
  return appendRecord(
    a,
    {
      partition: "shared",
      stream: "log",
      kind: "log-event",
      agent: "seed",
      body: { timestamp: new Date(ms).toISOString(), event_type: "note", body: { text } },
    },
    { now: () => ms },
  ).record.id;
}

function envFor(uses: string): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    // A hosted provider: private text may not go there.
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: uses,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

function sharedRecords() {
  return readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records);
}

describe("the decide pass on the planner's topic rules", () => {
  test("a completion of a merged topic's milestone is written under the item's owner", async () => {
    const owner = seedTopic("Shard compaction keeps monthly shard files small");
    const milestone = "m-window";
    topicRecord(TOPIC_MILESTONE_KIND, owner, {
      item: milestone,
      text: "Ship the first compaction window",
    });
    const home = seedTopic("Shard compaction rollout on every machine");
    topicRecord(TOPIC_MERGE_KIND, owner, { into: home });
    for (const text of [
      "Shard compaction window shipped and the rollup ledger closed",
      "Shard compaction window verified on every machine",
    ]) {
      topicRecord(TOPIC_ASSIGN_KIND, home, { record: signal(text) });
    }
    writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "milestone_done", {
      values: { done_min: 0.8 },
      source: "set",
    });
    resetThresholdsStoreCache();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.9 : undefined),
    });
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: envFor("milestone_done:enforce"),
      now,
    });
    expect(verdicts.completions).toEqual([
      expect.objectContaining({ topic: home, milestone }) as never,
    ]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
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
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(TOPIC_MILESTONE_KIND, topic, {
      item: "m-window",
      text: "Ship the first compaction window",
    });
    topicRecord(TOPIC_ASSIGN_KIND, topic, {
      record: signal("Shard compaction window shipped, said the acquisition memo", "private"),
    });
    writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "milestone_done", {
      values: { done_min: 0.8 },
      source: "set",
    });
    resetThresholdsStoreCache();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.95 : undefined),
    });
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: {
        ...envFor("milestone_done:enforce"),
        OPEN_SECOND_BRAIN_DECISION_MODEL_PRIVATE_USES: "milestone_done",
      },
      now,
    });
    expect(verdicts.completions).toHaveLength(1);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.completions : -1).toBe(1);
    expect(sharedRecords().filter((r) => r.kind === "milestone-done")).toEqual([]);
    const privateDone = readPartition(join(m.root("dev-a"), "private"))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === "milestone-done");
    expect(privateDone).toHaveLength(1);
  });

  test("a private milestone of a shared topic is never sent to a hosted provider", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(
      TOPIC_MILESTONE_KIND,
      topic,
      { item: "m-secret", text: "Ship the Halcyon compaction window" },
      "private",
    );
    topicRecord(TOPIC_ASSIGN_KIND, topic, {
      record: signal("Shard compaction window shipped and the rollup ledger closed"),
    });
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("milestone_done:shadow"), now });
    expect(fake.requests).toEqual([]);
  });

  test("a private rename of a shared topic never reaches a hosted provider", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
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
      record: signal("Shard compaction window decided: the nightly one ships first"),
    });
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("question_resolved:shadow"), now });
    expect(fake.requests).toHaveLength(1);
    const sent = JSON.stringify(fake.requests[0]!.state);
    expect(sent).toContain("Which compaction window ships first");
    expect(sent).not.toContain("Halcyon");
  });

  test("the history window follows the date the run is for", async () => {
    note("Routine heartbeat of the nightly compaction job", T0 - 20 * WEEK_MS);
    const asked = (): string[] =>
      fake.requests.flatMap((r) =>
        Object.values((r.state as { records: Record<string, string> }).records),
      );
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("human_readable:shadow"), now });
    expect(asked()).toEqual([]);
    await decideTopicPlan(a, {
      provider: fake,
      env: envFor("human_readable:shadow"),
      now,
      runAt: new Date(T0 - 19 * WEEK_MS),
    });
    expect(asked().join(" ")).toContain("Routine heartbeat");
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
        plan: { routes: [], creates: [], splits: [], merges: [], quiet: [], shortfalls: [] },
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
    const topic = seedTopic(
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
      record: signal("Shard compaction window shipped and the question settled"),
    });
    signal("Shard compaction keeps shard files small after the window");
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, {
      provider: fake,
      env: envFor(
        "topic_route:shadow,event_kind:shadow,question_resolved:shadow,milestone_done:shadow",
      ),
      now,
    });
    const uses = new Set(fake.requests.map((r) => r.use));
    expect(uses).toEqual(
      new Set(["topic_route", "event_kind", "question_resolved", "milestone_done"]),
    );
    const sent = JSON.stringify(fake.requests);
    expect(sent).not.toContain("HALCYON");
    expect(sent).toContain("Shard compaction");
  });

  test("a private record is never sent for event_kind or question_resolved, nor named in a call record", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(TOPIC_QUESTION_KIND, topic, {
      item: "q-window",
      text: "Which compaction window ships first",
    });
    const secret = signal("PRIVATE-TEXT the compaction window is the acquisition date", "private");
    topicRecord(TOPIC_ASSIGN_KIND, topic, { record: secret });
    topicRecord(TOPIC_ASSIGN_KIND, topic, {
      record: signal("Shard compaction window answered: the first one ships"),
    });
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, {
      provider: fake,
      env: envFor("event_kind:shadow,question_resolved:shadow"),
      now,
    });
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(fake.requests)).not.toContain("PRIVATE-TEXT");
    const ids = listDecisionModelCalls(vault).flatMap(
      (c) => (c.payload["record_ids"] as string[] | undefined) ?? [],
    );
    // Skipped before the per-pass cap: not even a withheld entry.
    expect(ids).not.toContain(secret);
    expect(ids).not.toContain("(withheld)");
    expect(ids.length).toBeGreaterThan(0);
  });

  test("a drafted title is withheld when a group member beyond the shown ones is private", async () => {
    // Eleven members: the ten oldest are shown, the newest is private and
    // its words count toward the drafted title all the same.
    for (let i = 0; i < 10; i++) {
      signal(`Deprecation windows for the public API, step ${i}`, "shared", `s${i % 2}`);
    }
    signal("PRIVATE-TEXT deprecation windows for the public API", "private", "s1");
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("topic_new:shadow"), now });
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests)).not.toContain("PRIVATE-TEXT");
    const state = fake.requests[0]!.state as { title: string; groups: Record<string, string> };
    expect(Object.keys(state.groups)).toHaveLength(10);
    expect(state.title).toBe("");
  });

  test("a word only inside a <private> region never reaches a drafted title, goal or the provider", async () => {
    // Private records of topic_new may go to the hosted provider here, so
    // the drafted title is sent; the region's word must not be in it.
    for (let i = 0; i < 5; i++) {
      signal(
        `<private>Zephyrquill</private> deprecation windows for the public API, step ${i}`,
        "shared",
        `s${i % 2}`,
      );
    }
    const fake = new FakeDecisionProvider({});
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: {
        ...envFor("topic_new:shadow"),
        OPEN_SECOND_BRAIN_DECISION_MODEL_PRIVATE_USES: "topic_new",
      },
      now,
    });
    expect(fake.requests).toHaveLength(1);
    const state = fake.requests[0]!.state as { title: string };
    expect(state.title).not.toBe("");
    expect(JSON.stringify(fake.requests).toLowerCase()).not.toContain("zephyrquill");
    runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    const stored = readPartition(join(m.root("dev-a"), "private"))
      .concat(readPartition(join(m.root("dev-a"), "shared")))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === TOPIC_CREATE_KIND);
    expect(stored).toHaveLength(1);
    const body = JSON.stringify(stored[0]!.body).toLowerCase();
    expect(body).not.toContain("zephyrquill");
    expect(body).not.toContain("***private***");
  });
});
