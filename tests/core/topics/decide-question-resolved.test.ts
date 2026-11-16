/**
 * `question_resolved` in the decide pass (task 4.1, design D10): `off`
 * sends nothing; `shadow` records the call without effect; `enforce`
 * writes a `question-resolved` proposal (`authority: "model"`) that the
 * fold shows as "looks answered" (`resolveProposed`) while the question
 * stays open; below the threshold, a timeout and a `none` answer
 * propose nothing.
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
  TOPIC_QUESTION_KIND,
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
  m = makeMachines(["dev-a"], "o2b-decide-res-");
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
        id: `sig-2026-12-01-q${seq}`,
        path: `Brain/inbox/q${seq}.md`,
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

function seedItem(
  topic: string,
  kind: string,
  body: Record<string, unknown>,
  authority: "agent" | "human" = "agent",
): string {
  clock += 1000;
  const item = `i${Math.floor(clock) % 100000}`;
  appendRecord(
    a,
    {
      partition: "shared",
      stream: "topics",
      kind,
      agent: "seed",
      topic,
      body: { authority, item, ...body },
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
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `question_resolved:${mode}`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

function tuneForEnforce(value = 0.7): void {
  writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "question_resolved", {
    values: { resolved_min: value },
    source: "set",
  });
  resetThresholdsStoreCache();
}

function resolutions(): Array<Record<string, unknown>> {
  return readPartition(join(m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "question-resolved")
    .map((r) => r.body);
}

function foldNow() {
  return foldTopics(readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records));
}

/** A topic with an open question and a record of a later decision that answers it. */
function seedTopicWithQuestion(): { topic: string; question: string; record: string } {
  const topic = seedTopic("Shard compaction keeps monthly shard files small");
  const question = seedItem(topic, TOPIC_QUESTION_KIND, {
    text: "Which threshold ships for the shard compaction?",
  });
  const record = signal("Shard compaction decision: the 24 MiB threshold ships next week");
  holdRecord(topic, record);
  return { topic, question, record };
}

describe("question_resolved after a merge", () => {
  test("two questions with one id in a merged topic: the proposal goes to the one chosen", async () => {
    const home = seedTopic("Shard compaction keeps monthly shard files small");
    const other = seedTopic("Shard compaction thresholds for the monthly files");
    // Item ids are a topic's own: both topics pick the same token.
    const question = (topic: string, text: string): void => {
      clock += 1000;
      appendRecord(
        a,
        {
          partition: "shared",
          stream: "topics",
          kind: TOPIC_QUESTION_KIND,
          agent: "seed",
          topic,
          body: { authority: "agent", item: "q1", text },
        },
        { now },
      );
    };
    question(home, "Who reviews the shard compaction pull request?");
    question(other, "Which threshold ships for the shard compaction?");
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
    const record = signal("Shard compaction decision: the 24 MiB threshold ships next week");
    holdRecord(home, record);
    tuneForEnforce();
    // Oldest first: Q0 is the home topic's question, Q1 the merged one's.
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "Q1" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    const written = readPartition(join(m.root("dev-a"), "shared"))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === "question-resolved");
    expect(written.map((r) => [r.topic, r.body["question"]])).toEqual([[other, "q1"]]);
    const shown = foldNow()
      .topics.get(home)!
      .items.filter((item) => item.id === "q1");
    expect(shown.map((item) => [item.owner, item.resolveProposed !== undefined])).toEqual([
      [home, false],
      [other, true],
    ]);
  });
});

describe("question_resolved in the decide pass", () => {
  test("the question texts count toward the state budget", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 6; i++) {
      seedItem(topic, TOPIC_QUESTION_KIND, {
        text: `Which threshold ${i} ships for the shard compaction? `.padEnd(300, "q"),
      });
    }
    const record = signal(`Shard compaction decision: the threshold ships. `.padEnd(900, "r"));
    holdRecord(topic, record);
    const maxStateTokens = 1000;
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
    // The record alone would fit; beside the questions nothing does.
    expect(fake.requests).toEqual([]);
  });

  test("off sends nothing and proposes nothing", async () => {
    seedTopicWithQuestion();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "Q0" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("off"), now });
    expect([...verdicts.resolutions.keys()]).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(vault)).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.resolutions : -1).toBe(0);
    expect(resolutions()).toEqual([]);
  });

  test("shadow asks once, records, and proposes nothing", async () => {
    seedTopicWithQuestion();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "Q0" : undefined),
      probability: 0.9,
      model: "res-shadow-1",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect([...verdicts.resolutions.keys()]).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("question_resolved");
    const state = fake.requests[0]!.state as {
      records: Record<string, { topic: string; text: string }>;
      questions: Record<string, string>;
    };
    expect(Object.keys(state.questions)).toEqual(["Q0"]);
    expect(state.records["R0"]!.text).toContain("24 MiB");
    const calls = listDecisionModelCalls(vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(resolutions()).toEqual([]);
  });

  test("two records answering one question in one pass write one proposal", async () => {
    const { topic, question, record } = seedTopicWithQuestion();
    const second = signal("Shard compaction decision confirmed: the 24 MiB threshold ships");
    holdRecord(topic, second);
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "Q0" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(verdicts.resolutions.get(record)).toMatchObject({ topic, question });
    expect(verdicts.resolutions.get(second)).toMatchObject({ topic, question });
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.resolutions : -1).toBe(1);
    expect(resolutions()).toHaveLength(1);
  });

  test("enforce writes the proposal; the fold shows it as looks answered", async () => {
    const { topic, question, record } = seedTopicWithQuestion();
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "Q0" : undefined),
      probability: 0.9,
      model: "res-model-2",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(verdicts.resolutions.get(record)).toMatchObject({ topic, question });
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.resolutions : -1).toBe(1);
    const written = resolutions();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      authority: "model",
      question,
      source: record,
      verdict: {
        use: "question_resolved",
        model: "res-model-2",
        mode: "enforce",
        version: 2,
        confidence: 0.9,
      },
    });
    // The fold shows "looks answered": the question stays open.
    const fold = foldNow();
    const item = fold.topics.get(topic)?.items.find((i) => i.id === question);
    expect(item?.resolveProposed).toBeDefined();
    expect(item?.resolved).toBeUndefined();
  });

  test("below the threshold, a timeout and a none answer propose nothing", async () => {
    const { topic } = seedTopicWithQuestion();
    tuneForEnforce();
    // A timeout first: it enters nothing in the asked set.
    const timeoutFake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "Q0" : undefined),
      probability: 0.9,
      fail: "timeout",
    });
    const timedOut = await decideTopicPlan(a, {
      provider: timeoutFake,
      env: envFor("enforce"),
      now,
    });
    expect(timeoutFake.requests).toHaveLength(1);
    expect([...timedOut.resolutions.keys()]).toEqual([]);
    // The same record, still unsettled, asked again.
    const lowFake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "Q0" : undefined),
      probability: 0.5,
    });
    const low = await decideTopicPlan(a, { provider: lowFake, env: envFor("enforce"), now });
    expect(lowFake.requests).toHaveLength(1);
    expect([...low.resolutions.keys()]).toEqual([]);
    // That answer entered the record in the asked set: `none` gets a record of its own.
    const fresh = signal("Shard compaction: the review of the threshold is still open");
    holdRecord(topic, fresh);
    const noneFake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "none" : undefined),
      probability: 0.95,
    });
    const none = await decideTopicPlan(a, { provider: noneFake, env: envFor("enforce"), now });
    expect(noneFake.requests).toHaveLength(1);
    expect(JSON.stringify(noneFake.requests[0]!.state)).toContain("still open");
    expect([...none.resolutions.keys()]).toEqual([]);
    expect(runTopicPlanning(a, { agent: "dream", now, topicVerdicts: none }).status).toBe(
      "planned",
    );
    expect(resolutions()).toEqual([]);
  });

  test("a question older than the record only is offered; a resolved one never", async () => {
    const { topic, question, record } = seedTopicWithQuestion();
    // Resolve the question by hand: it is no longer open.
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "topics",
        kind: "question-resolved",
        agent: "seed",
        topic,
        body: { authority: "human", question, answer: "24 MiB, decided by the user." },
      },
      { now },
    );
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(fake.requests).toEqual([]);
    void record;
  });
});

describe("resolved_min from the thresholds store", () => {
  test("a stored resolved_min above the answer decides, not the built-in default", async () => {
    const { record } = seedTopicWithQuestion();
    tuneForEnforce(0.95);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("answers_") ? "Q0" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    // Asked once, in enforce: the stored value is what rejected the answer.
    expect(fake.requests).toHaveLength(1);
    const calls = listDecisionModelCalls(vault);
    expect(calls.map((c) => c.payload["mode"])).toEqual(["enforce"]);
    // The built-in 0.7 would accept 0.9; the stored 0.95 decides.
    expect(verdicts.resolutions.get(record)).toBeUndefined();
  });
});
