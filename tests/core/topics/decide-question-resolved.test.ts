/**
 * `question_resolved` as queue items, one per held record (change
 * `dream-closed-questions`; was the decide pass, task 4.1, design D10):
 * `off` sends nothing; `shadow` records the call without effect;
 * `enforce` writes a `question-resolved` proposal (`authority: "model"`)
 * that the fold shows as "looks answered" (`resolveProposed`) while the
 * question stays open; below the threshold and a `none` answer abstain,
 * a timeout waits, and nothing is proposed for any of them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { TOPIC_MERGE_KIND, TOPIC_QUESTION_KIND } from "../../../src/core/topics/constants.ts";
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

function answers(
  choice: string,
  probability = 0.9,
  extra: { model?: string; fail?: "timeout" } = {},
): FakeDecisionProvider {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("answers_") ? choice : undefined),
    probability,
    ...extra,
  });
}

function resolutions(): Array<Record<string, unknown>> {
  return readPartition(join(f.m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "question-resolved")
    .map((r) => r.body);
}

function foldNow() {
  return foldTopics(readPartition(join(f.m.root("dev-a"), "shared")).flatMap((s) => s.records));
}

function resolved(report: ReturnType<typeof plan>): number {
  return report.status === "planned" ? report.resolutions : -1;
}

/** A topic with an open question and a record of a later decision that answers it. */
function seedTopicWithQuestion(): { topic: string; question: string; record: string } {
  const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
  const question = f.seedItem(topic, TOPIC_QUESTION_KIND, {
    text: "Which threshold ships for the shard compaction?",
  });
  const record = f.signal("Shard compaction decision: the 24 MiB threshold ships next week");
  f.holdRecord(topic, record);
  return { topic, question, record };
}

describe("question_resolved after a merge", () => {
  test("two questions with one id in a merged topic: the proposal goes to the one chosen", async () => {
    const home = f.seedTopic("Shard compaction keeps monthly shard files small");
    const other = f.seedTopic("Shard compaction thresholds for the monthly files");
    // Item ids are a topic's own: both topics pick the same token.
    const question = (topic: string, text: string): void => {
      appendRecord(
        f.a,
        {
          partition: "shared",
          stream: "topics",
          kind: TOPIC_QUESTION_KIND,
          agent: "seed",
          topic,
          body: { authority: "agent", item: "q1", text },
        },
        { now: f.now },
      );
    };
    question(home, "Who reviews the shard compaction pull request?");
    question(other, "Which threshold ships for the shard compaction?");
    appendRecord(
      f.a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_MERGE_KIND,
        agent: "seed",
        topic: other,
        body: { authority: "human", into: home },
      },
      { now: f.now },
    );
    const record = f.signal("Shard compaction decision: the 24 MiB threshold ships next week");
    f.holdRecord(home, record);
    f.tune("question_resolved", { resolved_min: 0.7 });
    // Oldest first: Q0 is the home topic's question, Q1 the merged one's.
    await ask(f, "question_resolved:enforce", answers("Q1"));
    plan(f);
    const written = readPartition(join(f.m.root("dev-a"), "shared"))
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

describe("question_resolved on the queue", () => {
  test("the question texts count toward the state budget", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 6; i++) {
      f.seedItem(topic, TOPIC_QUESTION_KIND, {
        text: `Which threshold ${i} ships for the shard compaction? `.padEnd(300, "q"),
      });
    }
    f.holdRecord(
      topic,
      f.signal(`Shard compaction decision: the threshold ships. `.padEnd(900, "r")),
    );
    const fake = new FakeDecisionProvider({});
    await ask(f, "question_resolved:shadow", fake, {
      OPEN_SECOND_BRAIN_DECISION_MODEL_MAX_STATE_TOKENS: "1000",
    });
    // The record alone would fit; beside the questions nothing does: no
    // request, a failed attempt for a state over the limit.
    expect(fake.requests).toEqual([]);
    const [item] = f.items("question-resolved");
    expect(item!.attempts).toBe(1);
    expect(item!.last_reason).toBe("budget");
  });

  test("off sends nothing and proposes nothing", async () => {
    seedTopicWithQuestion();
    const fake = answers("Q0");
    await ask(f, "question_resolved:off", fake);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(f.vault)).toEqual([]);
    expect(resolved(plan(f))).toBe(0);
    expect(resolutions()).toEqual([]);
  });

  test("shadow asks once, records, and proposes nothing", async () => {
    seedTopicWithQuestion();
    const fake = answers("Q0", 0.9, { model: "res-shadow-1" });
    await ask(f, "question_resolved:shadow", fake);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("question_resolved");
    const state = fake.requests[0]!.state as {
      records: Record<string, { topic: string; text: string }>;
      questions: Record<string, string>;
    };
    expect(Object.keys(state.questions)).toEqual(["Q0"]);
    expect(state.records["R0"]!.text).toContain("24 MiB");
    const calls = listDecisionModelCalls(f.vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    plan(f);
    expect(resolutions()).toEqual([]);
  });

  test("two records answering one question write one proposal", async () => {
    const { topic } = seedTopicWithQuestion();
    f.holdRecord(
      topic,
      f.signal("Shard compaction decision confirmed: the 24 MiB threshold ships"),
    );
    f.tune("question_resolved", { resolved_min: 0.7 });
    await ask(f, "question_resolved:enforce", answers("Q0"));
    expect(f.items("question-resolved").map((i) => i.state)).toEqual(["accepted", "accepted"]);
    expect(resolved(plan(f))).toBe(1);
    expect(resolutions()).toHaveLength(1);
  });

  test("enforce writes the proposal; the fold shows it as looks answered", async () => {
    const { topic, question, record } = seedTopicWithQuestion();
    f.tune("question_resolved", { resolved_min: 0.7 });
    await ask(f, "question_resolved:enforce", answers("Q0", 0.9, { model: "res-model-2" }));
    expect(resolved(plan(f))).toBe(1);
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
    const item = foldNow()
      .topics.get(topic)
      ?.items.find((i) => i.id === question);
    expect(item?.resolveProposed).toBeDefined();
    expect(item?.resolved).toBeUndefined();
  });

  test("below the threshold and a none answer abstain, a timeout waits; nothing is proposed", async () => {
    const { topic } = seedTopicWithQuestion();
    f.tune("question_resolved", { resolved_min: 0.7 });
    // A timeout first: the item waits with a retry time.
    const timeoutFake = answers("Q0", 0.9, { fail: "timeout" });
    await ask(f, "question_resolved:enforce", timeoutFake);
    expect(timeoutFake.requests).toHaveLength(1);
    const [waiting] = f.items("question-resolved");
    expect(waiting!.attempts).toBe(1);
    expect(resolved(plan(f))).toBe(0);
    // The same record, asked again after the retry time: below the threshold.
    f.setClock(Date.parse(waiting!.retry_at!) + 1000);
    const lowFake = answers("Q0", 0.5);
    await ask(f, "question_resolved:enforce", lowFake);
    expect(lowFake.requests).toHaveLength(1);
    const low = plan(f);
    expect(low.status === "planned" && low.abstained).toBe(1);
    // That item abstained: `none` gets a record of its own.
    f.holdRecord(topic, f.signal("Shard compaction: the review of the threshold is still open"));
    const noneFake = answers("none", 0.95);
    await ask(f, "question_resolved:enforce", noneFake);
    expect(noneFake.requests).toHaveLength(1);
    expect(JSON.stringify(noneFake.requests[0]!.state)).toContain("still open");
    const none = plan(f);
    expect(none.status === "planned" && none.abstained).toBe(1);
    expect(resolutions()).toEqual([]);
  });

  test("a question older than the record only is offered; a resolved one never", async () => {
    const { topic, question } = seedTopicWithQuestion();
    // Resolve the question by hand: it is no longer open.
    appendRecord(
      f.a,
      {
        partition: "shared",
        stream: "topics",
        kind: "question-resolved",
        agent: "seed",
        topic,
        body: { authority: "human", question, answer: "24 MiB, decided by the user." },
      },
      { now: f.now },
    );
    const fake = new FakeDecisionProvider({});
    await ask(f, "question_resolved:shadow", fake);
    expect(fake.requests).toEqual([]);
    expect(f.items("question-resolved")).toEqual([]);
  });
});

describe("resolved_min from the thresholds store", () => {
  test("a stored resolved_min above the answer decides, not the built-in default", async () => {
    seedTopicWithQuestion();
    f.tune("question_resolved", { resolved_min: 0.95 });
    const fake = answers("Q0");
    await ask(f, "question_resolved:enforce", fake);
    // Asked once, in enforce: the stored value is what rejected the answer.
    expect(fake.requests).toHaveLength(1);
    expect(listDecisionModelCalls(f.vault).map((c) => c.payload["mode"])).toEqual(["enforce"]);
    // The built-in 0.7 would accept 0.9; the stored 0.95 decides.
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(1);
    expect(resolutions()).toEqual([]);
  });
});
