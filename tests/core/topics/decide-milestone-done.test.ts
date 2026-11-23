/**
 * `milestone_done` as queue items, one per open milestone with newer held
 * records (change `dream-closed-questions`; was the decide pass, task
 * 4.1, design D10): `off` sends nothing; `shadow` records the call
 * without effect; `enforce` writes a `milestone-done` proposal
 * (`authority: "model"`, never `evidence`) that the fold shows as "looks
 * done, confirm" (`doneProposed`) while the milestone stays open; below
 * the threshold the item abstains and on a timeout it waits, nothing
 * proposed either way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { TOPIC_MERGE_KIND, TOPIC_MILESTONE_KIND } from "../../../src/core/topics/constants.ts";
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

function done(p: number, extra: { model?: string; fail?: "timeout" } = {}): FakeDecisionProvider {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("done_") ? p : undefined),
    ...extra,
  });
}

function completions(): Array<Record<string, unknown>> {
  return readPartition(join(f.m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "milestone-done")
    .map((r) => r.body);
}

function foldNow() {
  return foldTopics(readPartition(join(f.m.root("dev-a"), "shared")).flatMap((s) => s.records));
}

function completed(report: ReturnType<typeof plan>): number {
  return report.status === "planned" ? report.completions : -1;
}

function seedMilestone(topic: string, text: string): string {
  return f.seedItem(topic, TOPIC_MILESTONE_KIND, { text });
}

/** A topic with an open milestone and newer held records showing progress. */
function seedTopicWithMilestone(): { topic: string; milestone: string; records: string[] } {
  const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
  const milestone = seedMilestone(topic, "Ship the first compaction window");
  const records = [
    f.signal("Shard compaction window shipped and the rollup ledger closed"),
    f.signal("Shard compaction window verified on every machine"),
  ];
  for (const record of records) f.holdRecord(topic, record);
  return { topic, milestone, records };
}

describe("milestone_done after a merge", () => {
  test("two milestones with one id in a merged topic: the proposal goes to the one judged done", async () => {
    const home = f.seedTopic("Shard compaction keeps monthly shard files small");
    const other = f.seedTopic("Shard compaction thresholds for the monthly files");
    // Item ids are a topic's own: both topics pick the same token.
    const milestone = (topic: string, text: string): void => {
      appendRecord(
        f.a,
        {
          partition: "shared",
          stream: "topics",
          kind: TOPIC_MILESTONE_KIND,
          agent: "seed",
          topic,
          body: { authority: "agent", item: "m1", text },
        },
        { now: f.now },
      );
    };
    milestone(home, "Publish the shard compaction design review");
    milestone(other, "Ship the 24 MiB compaction threshold");
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
    f.holdRecord(home, f.signal("Shard compaction: the 24 MiB threshold shipped in the release"));
    f.tune("milestone_done", { done_min: 0.8 });
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
    await ask(f, "milestone_done:enforce", fake);
    expect(fake.requests).toHaveLength(2);
    plan(f);
    const written = readPartition(join(f.m.root("dev-a"), "shared"))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === "milestone-done");
    expect(written.map((r) => [r.topic, r.body["milestone"]])).toEqual([[other, "m1"]]);
  });
});

describe("milestone_done on the queue", () => {
  test("the milestone text counts toward the state budget", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    seedMilestone(topic, "Ship the first compaction window ".padEnd(300, "m"));
    f.holdRecord(topic, f.signal("Shard compaction window shipped ".padEnd(300, "r")));
    const fake = new FakeDecisionProvider({});
    await ask(f, "milestone_done:shadow", fake, {
      OPEN_SECOND_BRAIN_DECISION_MODEL_MAX_STATE_TOKENS: "500",
    });
    // The record alone would fit; beside the milestone nothing does: no
    // request, a failed attempt for a state over the limit.
    expect(fake.requests).toEqual([]);
    const [item] = f.items("milestone-done");
    expect(item!.last_reason).toBe("budget");
  });

  test("off sends nothing and proposes nothing", async () => {
    seedTopicWithMilestone();
    const fake = done(0.9);
    await ask(f, "milestone_done:off", fake);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(f.vault)).toEqual([]);
    expect(completed(plan(f))).toBe(0);
    expect(completions()).toEqual([]);
  });

  test("shadow asks once, records, and proposes nothing", async () => {
    seedTopicWithMilestone();
    const fake = done(0.9, { model: "done-shadow-1" });
    await ask(f, "milestone_done:shadow", fake);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("milestone_done");
    const state = fake.requests[0]!.state as {
      milestones: Record<string, string>;
      records: Record<string, string>;
    };
    expect(state.milestones["M0"]).toContain("compaction window");
    expect(Object.keys(state.records).length).toBe(2);
    const calls = listDecisionModelCalls(f.vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    plan(f);
    expect(completions()).toEqual([]);
  });

  test("enforce writes the proposal; the fold shows looks done and the milestone stays open", async () => {
    const { topic, milestone } = seedTopicWithMilestone();
    f.tune("milestone_done", { done_min: 0.8 });
    await ask(f, "milestone_done:enforce", done(0.9, { model: "done-model-3" }));
    expect(completed(plan(f))).toBe(1);
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
    const item = foldNow()
      .topics.get(topic)
      ?.items.find((i) => i.id === milestone);
    expect(item?.doneProposed).toBeDefined();
    expect(item?.done).toBeUndefined();
  });

  test("below the threshold the item abstains and on a timeout it waits; nothing is proposed", async () => {
    seedTopicWithMilestone();
    f.tune("milestone_done", { done_min: 0.8 });
    const timeoutFake = done(0.9, { fail: "timeout" });
    await ask(f, "milestone_done:enforce", timeoutFake);
    expect(timeoutFake.requests).toHaveLength(1);
    const [waiting] = f.items("milestone-done");
    expect(waiting!.attempts).toBe(1);
    expect(completed(plan(f))).toBe(0);
    f.setClock(Date.parse(waiting!.retry_at!) + 1000);
    const lowFake = done(0.7);
    await ask(f, "milestone_done:enforce", lowFake);
    expect(lowFake.requests).toHaveLength(1);
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(1);
    expect(completions()).toEqual([]);
  });

  test("a milestone with no newer held records is never asked about", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    seedMilestone(topic, "Ship the first compaction window");
    const fake = new FakeDecisionProvider({});
    await ask(f, "milestone_done:shadow", fake);
    expect(fake.requests).toEqual([]);
    expect(f.items("milestone-done")).toEqual([]);
  });

  test("a record arriving in the topic gives the milestone a new input, asked again", async () => {
    const { topic } = seedTopicWithMilestone();
    const first = done(0.9);
    await ask(f, "milestone_done:shadow", first);
    expect(first.requests).toHaveLength(1);
    f.holdRecord(topic, f.signal("Shard compaction window rolled out to the last machine"));
    const second = done(0.9);
    await ask(f, "milestone_done:shadow", second);
    // The five newest held records are the input: a new one changes it.
    expect(f.items("milestone-done")).toHaveLength(2);
    expect(second.requests).toHaveLength(1);
    expect(JSON.stringify(second.requests[0]!.state)).toContain("last machine");
  });
});

describe("done_min from the thresholds store", () => {
  test("a stored done_min above the answer decides, not the built-in default", async () => {
    seedTopicWithMilestone();
    f.tune("milestone_done", { done_min: 0.95 });
    const fake = done(0.9);
    await ask(f, "milestone_done:enforce", fake);
    // Asked once, in enforce: the stored value is what rejected the answer.
    expect(fake.requests).toHaveLength(1);
    expect(listDecisionModelCalls(f.vault).map((c) => c.payload["mode"])).toEqual(["enforce"]);
    // The built-in 0.8 would accept 0.9; the stored 0.95 decides.
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(1);
    expect(completions()).toEqual([]);
  });
});

describe("milestone_done evidence order", () => {
  test("evidence dated in the future does not take the place of present evidence", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    seedMilestone(topic, "Ship the first compaction window");
    for (let i = 0; i < 5; i++) {
      f.holdRecord(topic, f.signal(`Shard compaction window present step ${i} shipped`));
    }
    const runAt = f.still() + 1000;
    // A device with a fast clock: its records claim a month from now.
    f.setClock(f.still() + 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      f.holdRecord(topic, f.signal(`Shard compaction window FUTURE step ${i} shipped`));
    }
    // The pass runs for the present.
    f.setClock(runAt);
    const fake = done(0.9);
    await ask(f, "milestone_done:shadow", fake);
    expect(fake.requests).toHaveLength(1);
    const records = Object.values(
      (fake.requests[0]!.state as { records: Record<string, string> }).records,
    );
    expect(records).toHaveLength(5);
    expect(records.filter((text) => text.includes("FUTURE"))).toEqual([]);
  });
});
