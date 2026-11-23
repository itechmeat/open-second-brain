/**
 * No private subject keeps a shareable one from being asked (design D20;
 * change `dream-closed-questions`, design D3.7, D4.3): the per-pass caps
 * are gone, every subject is its own queue item, and an item built from
 * a private source sits in the private partition and is released for a
 * local executor (`egress-refused`) when the chain is hosted, without a
 * failed attempt, so the shareable items behind it are asked. An item
 * whose own input mixes private and shared sources (options, shown
 * members, shown evidence) is private as a whole: nothing of it is sent,
 * and it waits for a local executor. One test per former cap. Fake
 * provider, no HTTP.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TOPIC_DECISION_LIMITS } from "../../../src/core/decision-model/questions-topics.ts";
import type { StorePartition } from "../../../src/core/store/constants.ts";
import { TOPIC_MILESTONE_KIND, TOPIC_QUESTION_KIND } from "../../../src/core/topics/constants.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import { ask } from "./fixtures/closed-run.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

const FORMER_RECORDS_PER_PASS = TOPIC_DECISION_LIMITS.recordsPerPass;

function held(topic: string, text: string, partition: StorePartition): void {
  f.holdRecord(topic, f.signal(text, { partition }));
}

/** What a hosted provider in shadow was sent for `use`. */
async function sentFor(use: string): Promise<string> {
  const fake = new FakeDecisionProvider({});
  await ask(f, `${use}:shadow`, fake);
  return JSON.stringify(fake.requests);
}

/** The release reasons of the items of `operation`, private items only. */
function refusedPrivate(operation: string): Array<string | undefined> {
  return f
    .items(operation)
    .filter((i) => i.partition === "private")
    .map((i) => i.last_release?.reason);
}

/** Five near-identical signals of one project: one `topic_new` group. */
function signalGroup(project: string, partition: StorePartition, tag: string): void {
  for (let i = 0; i < 5; i++) {
    f.signal(`${tag} deprecation windows for the public API ${i}`, {
      partition,
      project,
      session: `s${i % 2}`,
    });
  }
}

describe("private items never keep a shareable one from being asked", () => {
  test("event_kind: a private backlog does not hold up a shared record", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    held(topic, "SHARED-ONE shard compaction window decided", "shared");
    for (let i = 0; i < FORMER_RECORDS_PER_PASS; i++) {
      held(topic, `Private compaction note ${i}`, "private");
    }
    const sent = await sentFor("event_kind");
    expect(sent).toContain("SHARED-ONE");
    expect(sent).not.toContain("Private compaction note");
    expect(new Set(refusedPrivate("event-kind"))).toEqual(new Set(["egress-refused"]));
    for (const item of f.items("event-kind")) expect(item.attempts).toBe(0);
  }, 30_000);

  test("topic_route: a private backlog does not hold up a shared record", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.signal("SHARED-ONE shard compaction thresholds were tuned", { partition: "shared" });
    for (let i = 0; i < FORMER_RECORDS_PER_PASS; i++) {
      f.signal(`Private shard compaction thresholds note ${i}`, { partition: "private" });
    }
    const sent = await sentFor("topic_route");
    expect(sent).toContain("SHARED-ONE");
    expect(sent).not.toContain("Private shard compaction");
  }, 30_000);

  test("topic_route: private topics among the options make the item wait for a local executor", async () => {
    // The shared topic ranks last: the private ones share more words.
    f.seedTopic("Shard compaction notes");
    for (let i = 0; i < TOPIC_DECISION_LIMITS.topicOptionsPerQuestion; i++) {
      f.seedTopic(`Shard compaction thresholds tuned nightly ${i}`, { partition: "private" });
    }
    f.signal("Shard compaction thresholds were tuned nightly", { partition: "shared" });
    const sent = await sentFor("topic_route");
    expect(sent).toBe("[]");
    expect(refusedPrivate("topic-route")).toEqual(["egress-refused"]);
  });

  test("question_resolved: a private backlog does not hold up a shared answer", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.seedItem(topic, TOPIC_QUESTION_KIND, { text: "Which compaction window ships first" });
    held(topic, "SHARED-ONE compaction window answered: the nightly one", "shared");
    for (let i = 0; i < FORMER_RECORDS_PER_PASS; i++) {
      held(topic, `Private compaction answer ${i}`, "private");
    }
    const sent = await sentFor("question_resolved");
    expect(sent).toContain("SHARED-ONE");
    expect(sent).not.toContain("Private compaction answer");
  }, 30_000);

  test("milestone_done: private evidence among the shown records makes the item wait", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.seedItem(topic, TOPIC_MILESTONE_KIND, { text: "Ship the first compaction window" });
    held(topic, "SHARED-ONE compaction window shipped", "shared");
    for (let i = 0; i < 5; i++) held(topic, `Private compaction evidence ${i}`, "private");
    const sent = await sentFor("milestone_done");
    expect(sent).toBe("[]");
    expect(refusedPrivate("milestone-done")).toEqual(["egress-refused"]);
  });

  test("topic_new: all-private groups do not fill the group cap ahead of a shared one", async () => {
    for (let g = 0; g < TOPIC_DECISION_LIMITS.groupsPerPass; g++) {
      signalGroup(`a${String(g).padStart(2, "0")}`, "private", "Private");
    }
    // Projects plan in name order: this group comes after every private one.
    signalGroup("zz", "shared", "SHARED-ONE");
    const sent = await sentFor("topic_new");
    expect(sent).toContain("SHARED-ONE");
    expect(sent).not.toContain("Private deprecation");
  });

  test("topic_new: private members make the group's item wait for a local executor", async () => {
    // Members are shown oldest first: the private ones come first here.
    for (let i = 0; i < TOPIC_DECISION_LIMITS.groupMembersShown; i++) {
      f.signal(`Private deprecation windows for the public API ${i}`, {
        partition: "private",
        session: `s${i % 2}`,
      });
    }
    for (let i = 0; i < 2; i++) {
      f.signal(`SHARED-ONE deprecation windows for the public API ${i}`, { session: `s${i}` });
    }
    const sent = await sentFor("topic_new");
    expect(sent).toBe("[]");
    expect(refusedPrivate("topic-new")).toEqual(["egress-refused"]);
  });

  test("topic_same: private topic pairs do not fill the pair cap ahead of a shared one", async () => {
    for (let p = 0; p < TOPIC_DECISION_LIMITS.pairsPerPass; p++) {
      // Identical private titles: the best-scoring pairs.
      const title = `Workstream${p} rollout${p} planning${p}`;
      f.seedTopic(title, { partition: "private" });
      f.seedTopic(title, { partition: "private" });
    }
    f.seedTopic("SHARED-ONE shard compaction monthly files");
    f.seedTopic("SHARED-ONE shard compaction weekly files");
    const sent = await sentFor("topic_same");
    expect(sent).toContain("SHARED-ONE");
    expect(sent).not.toContain("Workstream");
  }, 30_000);
});
