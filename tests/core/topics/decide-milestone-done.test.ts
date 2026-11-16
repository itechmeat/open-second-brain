/**
 * `milestone_done` in the decide pass (task 4.1, design D10): `off`
 * sends nothing; `shadow` records the call without effect; `enforce`
 * writes a `milestone-done` proposal (`authority: "model"`, never
 * `evidence`) that the fold shows as "looks done, confirm"
 * (`doneProposed`) while the milestone stays open; below the threshold
 * and on a timeout nothing is proposed.
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
  TOPIC_CREATE_KIND,
  TOPIC_MERGE_KIND,
  TOPIC_MILESTONE_KIND,
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
  m = makeMachines(["dev-a"], "o2b-decide-done-");
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
        id: `sig-2026-12-01-d${seq}`,
        path: `Brain/inbox/d${seq}.md`,
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

function seedMilestone(topic: string, text: string): string {
  clock += 1000;
  const item = `m${Math.floor(clock) % 100000}`;
  appendRecord(
    a,
    {
      partition: "shared",
      stream: "topics",
      kind: TOPIC_MILESTONE_KIND,
      agent: "seed",
      topic,
      body: { authority: "agent", item, text },
    },
    { now },
  );
  return item;
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
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `milestone_done:${mode}`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

function tuneForEnforce(value = 0.8): void {
  writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "milestone_done", {
    values: { done_min: value },
    source: "set",
  });
  resetThresholdsStoreCache();
}

function completions(): Array<Record<string, unknown>> {
  return readPartition(join(m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "milestone-done")
    .map((r) => r.body);
}

function foldNow() {
  return foldTopics(readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records));
}

/** A topic with an open milestone and newer held records showing progress. */
function seedTopicWithMilestone(): { topic: string; milestone: string; records: string[] } {
  const topic = seedTopic("Shard compaction keeps monthly shard files small");
  const milestone = seedMilestone(topic, "Ship the first compaction window");
  const records = [
    signal("Shard compaction window shipped and the rollup ledger closed"),
    signal("Shard compaction window verified on every machine"),
  ];
  for (const record of records) holdRecord(topic, record);
  return { topic, milestone, records };
}

describe("milestone_done after a merge", () => {
  test("two milestones with one id in a merged topic: the proposal goes to the one judged done", async () => {
    const home = seedTopic("Shard compaction keeps monthly shard files small");
    const other = seedTopic("Shard compaction thresholds for the monthly files");
    // Item ids are a topic's own: both topics pick the same token.
    const milestone = (topic: string, text: string): void => {
      clock += 1000;
      appendRecord(
        a,
        {
          partition: "shared",
          stream: "topics",
          kind: TOPIC_MILESTONE_KIND,
          agent: "seed",
          topic,
          body: { authority: "agent", item: "m1", text },
        },
        { now },
      );
    };
    milestone(home, "Publish the shard compaction design review");
    milestone(other, "Ship the 24 MiB compaction threshold");
    clock += 1000;
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_MERGE_KIND,
        agent: "seed",
        topic: other,
        body: { authority: "human", into: home },
      },
      { now },
    );
    holdRecord(home, signal("Shard compaction: the 24 MiB threshold shipped in the release"));
    tuneForEnforce();
    // Done only for the merged topic's milestone.
    const fake = new FakeDecisionProvider({
      answer: (id, req) =>
        id.startsWith("done_")
          ? (req.state as { milestones: Record<string, string> }).milestones["M0"]!.includes(
              "threshold",
            )
            ? 0.9
            : 0.1
          : undefined,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(fake.requests).toHaveLength(2);
    runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    const written = readPartition(join(m.root("dev-a"), "shared"))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === "milestone-done");
    expect(written.map((r) => [r.topic, r.body["milestone"]])).toEqual([[other, "m1"]]);
  });
});

describe("milestone_done in the decide pass", () => {
  test("the milestone text counts toward the state budget", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    seedMilestone(topic, "Ship the first compaction window ".padEnd(300, "m"));
    holdRecord(topic, signal("Shard compaction window shipped ".padEnd(300, "r")));
    const maxStateTokens = 500;
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, {
      provider: fake,
      env: {
        ...envFor("shadow"),
        OPEN_SECOND_BRAIN_DECISION_MODEL_MAX_STATE_TOKENS: String(maxStateTokens),
      },
      now,
    });
    for (const request of fake.requests) {
      expect(estimateTokens(request.state) + QUESTION_TOKEN_ALLOWANCE).toBeLessThanOrEqual(
        maxStateTokens,
      );
    }
    // The record alone would fit; beside the milestone nothing does.
    expect(fake.requests).toEqual([]);
  });

  test("off sends nothing and proposes nothing", async () => {
    seedTopicWithMilestone();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.9 : undefined),
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("off"), now });
    expect(verdicts.completions).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(vault)).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.completions : -1).toBe(0);
    expect(completions()).toEqual([]);
  });

  test("shadow asks once, records, and proposes nothing", async () => {
    seedTopicWithMilestone();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.9 : undefined),
      model: "done-shadow-1",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(verdicts.completions).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("milestone_done");
    const state = fake.requests[0]!.state as {
      milestones: Record<string, string>;
      records: Record<string, string>;
    };
    expect(state.milestones["M0"]).toContain("compaction window");
    expect(Object.keys(state.records).length).toBe(2);
    const calls = listDecisionModelCalls(vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(completions()).toEqual([]);
  });

  test("enforce writes the proposal; the fold shows looks done and the milestone stays open", async () => {
    const { topic, milestone } = seedTopicWithMilestone();
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.9 : undefined),
      model: "done-model-3",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(verdicts.completions).toHaveLength(1);
    expect(verdicts.completions[0]).toMatchObject({ topic, milestone });
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.completions : -1).toBe(1);
    const written = completions();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      authority: "model",
      milestone,
      verdict: {
        use: "milestone_done",
        model: "done-model-3",
        mode: "enforce",
        version: 2,
        confidence: 0.9,
      },
    });
    expect(JSON.stringify(written[0])).not.toContain("evidence");
    // The fold shows "looks done, confirm"; the milestone stays open.
    const fold = foldNow();
    const item = fold.topics.get(topic)?.items.find((i) => i.id === milestone);
    expect(item?.doneProposed).toBeDefined();
    expect(item?.done).toBeUndefined();
  });

  test("below the threshold and on a timeout nothing is proposed", async () => {
    seedTopicWithMilestone();
    tuneForEnforce();
    // A timeout first: it enters nothing in the asked set, so the
    // below-threshold pass after it asks about the same milestone.
    const timeoutFake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.9 : undefined),
      fail: "timeout",
    });
    const timedOut = await decideTopicPlan(a, {
      provider: timeoutFake,
      env: envFor("enforce"),
      now,
    });
    expect(timeoutFake.requests).toHaveLength(1);
    expect(timedOut.completions).toEqual([]);
    const lowFake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.7 : undefined),
    });
    const low = await decideTopicPlan(a, { provider: lowFake, env: envFor("enforce"), now });
    expect(lowFake.requests).toHaveLength(1);
    expect(low.completions).toEqual([]);
    expect(runTopicPlanning(a, { agent: "dream", now, topicVerdicts: low }).status).toBe("planned");
    expect(completions()).toEqual([]);
  });

  test("a milestone with no newer held records is never asked about", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    seedMilestone(topic, "Ship the first compaction window");
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(fake.requests).toEqual([]);
  });
});

describe("done_min from the thresholds store", () => {
  test("a stored done_min above the answer decides, not the built-in default", async () => {
    seedTopicWithMilestone();
    tuneForEnforce(0.95);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.9 : undefined),
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    // Asked once, in enforce: the stored value is what rejected the answer.
    expect(fake.requests).toHaveLength(1);
    const calls = listDecisionModelCalls(vault);
    expect(calls.map((c) => c.payload["mode"])).toEqual(["enforce"]);
    // The built-in 0.8 would accept 0.9; the stored 0.95 decides.
    expect(verdicts.completions).toEqual([]);
  });
});

describe("milestone_done evidence order", () => {
  test("evidence dated in the future does not take the place of present evidence", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    seedMilestone(topic, "Ship the first compaction window");
    for (let i = 0; i < 5; i++) {
      holdRecord(topic, signal(`Shard compaction window present step ${i} shipped`));
    }
    const runAt = new Date(clock + 1000);
    // A device with a fast clock: its records claim a month from now.
    clock += 30 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      holdRecord(topic, signal(`Shard compaction window FUTURE step ${i} shipped`));
    }
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("done_") ? 0.9 : undefined),
    });
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now, runAt });
    expect(fake.requests).toHaveLength(1);
    const records = Object.values(
      (fake.requests[0]!.state as { records: Record<string, string> }).records,
    );
    expect(records).toHaveLength(5);
    expect(records.filter((text) => text.includes("FUTURE"))).toEqual([]);
  });
});
