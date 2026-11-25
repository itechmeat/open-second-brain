/**
 * Topics group records by theme, never by project (owner decision): a
 * record that names no project (a migrated one included) groups and
 * routes like any other, across sessions, machines and directories. A
 * topic made of the records of one project is scoped to it; any other is
 * `personal` (no project). Shared and private records group apart. A
 * signal the regex fact extraction wrote is never grouped or routed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import type { TopicCandidate } from "../../../src/core/topics/candidates.ts";
import { TOPIC_CREATE_KIND } from "../../../src/core/topics/constants.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { planTopics } from "../../../src/core/topics/plan.ts";
import {
  emptyTopicVerdicts,
  topicGroupKey,
  type TopicVerdictBody,
  type TopicVerdicts,
} from "../../../src/core/topics/verdicts.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";
import { seedTopicRecord } from "../view/fixtures/seed.ts";

const SETTINGS = { minRecords: 5, minSessions: 2, quietDays: 30 };
const SUBJECT = "Shard compaction keeps monthly shard files small";

function candidate(
  id: string,
  options: Partial<TopicCandidate> & { readonly session: string },
): TopicCandidate {
  return {
    id,
    kind: "note",
    text: `${SUBJECT} ${id}`,
    project: null,
    at: Number(id.replace(/\D/g, "")) || 0,
    private: false,
    topic: null,
    ...options,
  };
}

/** Five related records from two sessions, each naming `project`. */
function related(project: (i: number) => string | null): TopicCandidate[] {
  return [0, 1, 2, 3, 4].map((i) =>
    candidate(`r${i + 1}`, { session: i < 3 ? "s1" : "s2", project: project(i) }),
  );
}

const VERDICT: TopicVerdictBody = {
  use: "topic_new",
  model: "test-model-1",
  provider: "test-preset",
  version: 1,
  mode: "enforce",
  confidence: 0.9,
};

/** An approval and a wording for the group of `members`. */
function approved(members: ReadonlyArray<TopicCandidate>): TopicVerdicts {
  const key = topicGroupKey(members.map((m) => m.id));
  return {
    ...emptyTopicVerdicts(),
    vetoes: new Map([[key, { verdict: VERDICT, veto: false }]]),
    wordings: new Map([
      [
        key,
        { title: "Shard compaction", goal: "Keep shards small", agent: "a", model: "m", item: "i" },
      ],
    ]),
  };
}

test("records that name no project, from two sessions, make a shared topic with no project", () => {
  const members = related(() => null);
  const asked = planTopics(foldTopics([]), members, SETTINGS, 0);
  expect(asked.asks.groups).toHaveLength(1);
  expect(asked.asks.groups[0]).toMatchObject({ scope: "personal", private: false });
  expect(asked.shortfall?.asked).toBe(1);

  const plan = planTopics(foldTopics([]), members, SETTINGS, 0, approved(members));
  expect(plan.creates).toHaveLength(1);
  expect(plan.creates[0]).toMatchObject({
    scope: "personal",
    private: false,
    members: members.map((m) => m.id),
    sessions: 2,
  });
});

test("records of two projects and of none group by theme into one topic with no project", () => {
  const members = related((i) => (i === 0 ? "alpha" : i === 1 ? "beta" : null));
  const plan = planTopics(foldTopics([]), members, SETTINGS, 0, approved(members));
  expect(plan.creates.map((c) => [c.scope, c.members.length])).toEqual([["personal", 5]]);
});

test("a topic of the records of one project is still scoped to that project", () => {
  const members = related(() => "o2b");
  const plan = planTopics(foldTopics([]), members, SETTINGS, 0, approved(members));
  expect(plan.creates.map((c) => c.scope)).toEqual(["project:o2b"]);
});

test("private records group apart: a private record never joins or shapes a shared topic", () => {
  const shared = related(() => null);
  const secret = related(() => null).map((m) => ({ ...m, id: `p${m.id}`, private: true }));
  const plan = planTopics(foldTopics([]), [...shared, ...secret], SETTINGS, 0);
  expect(plan.asks.groups.map((g) => [g.private, g.members])).toEqual([
    [false, shared.map((m) => m.id)],
    [true, secret.map((m) => m.id)],
  ]);
  // One private record less leaves the private records short of a topic,
  // and the shared topic exactly as it was.
  const fewer = planTopics(foldTopics([]), [...shared, ...secret.slice(1)], SETTINGS, 0);
  expect(fewer.asks.groups.map((g) => [g.private, g.members])).toEqual([
    [false, shared.map((m) => m.id)],
  ]);
});

test("signals of the regex fact extraction are never grouped", () => {
  const facts = related(() => null).map((m) => ({
    ...m,
    kind: "signal" as const,
    extracted: true,
  }));
  const plan = planTopics(foldTopics([]), facts, SETTINGS, 0);
  expect(plan.asks.groups).toEqual([]);
  expect(plan.shortfall).toBeNull();
});

test("unrelated records with a common word do not chain into one group", () => {
  const a = [0, 1, 2].map((i) =>
    candidate(`a${i + 1}`, { session: `s${i}`, text: "garden watering schedule alley beds" }),
  );
  const bridge = candidate("b9", {
    session: "s9",
    text: "garden watering schedule shard compaction monthly",
  });
  const b = [0, 1, 2].map((i) =>
    candidate(`c${i + 10}`, { session: `s${i}`, text: "shard compaction monthly files small" }),
  );
  const plan = planTopics(foldTopics([]), [...a, bridge, ...b], { ...SETTINGS, minRecords: 4 }, 0);
  // The bridge joins the garden group (its leader shares three words); the
  // shard records never reach the garden leader through it.
  expect(plan.asks.groups.map((g) => g.members)).toEqual([["a1", "a2", "a3", "b9"]]);
});

let m: Machines;
let store: StoreHandle;
beforeEach(() => {
  m = makeMachines(["dev-a"], "o2b-theme-topics-");
  store = m.open("dev-a");
});
afterEach(() => m.cleanup());

test("a record that names no project is offered a project's topic it fits, and routed by an answer", () => {
  const at = Date.UTC(2026, 10, 2, 9);
  const topic = newUlid(at);
  seedTopicRecord(store, at, TOPIC_CREATE_KIND, topic, { title: SUBJECT, scope: "project:o2b" });
  const records = readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records);
  const fold = foldTopics(records);
  const record = candidate("x1", { session: "s1", text: "Shard compaction of monthly files ran" });

  const asked = planTopics(fold, [record], SETTINGS, at);
  expect(asked.asks.routes).toEqual([{ record: "x1", topics: [topic] }]);

  const routed = planTopics(fold, [record], SETTINGS, at, {
    ...emptyTopicVerdicts(),
    routes: new Map([[record.id, { topic, verdict: VERDICT, privateInput: false }]]),
  });
  expect(routed.routes).toEqual([{ record: "x1", topic, private: false, verdict: VERDICT }]);
});

test("an approval and its wording stand when another record joins the group", () => {
  const members = related(() => null);
  const verdicts = approved(members);
  const grown = [...members, candidate("r6", { session: "s2" })];
  const plan = planTopics(foldTopics([]), grown, SETTINGS, 0, verdicts);
  expect(plan.asks.groups).toEqual([]);
  expect(plan.creates.map((c) => c.members)).toEqual([grown.map((m) => m.id)]);
});

test("a veto holds while the group grows by less than half, and is asked again past it", () => {
  const members = related(() => null);
  const vetoed = (n: number): TopicVerdicts => ({
    ...emptyTopicVerdicts(),
    vetoes: new Map([
      [topicGroupKey(members.map((m) => m.id)), { verdict: VERDICT, veto: true, members: n }],
    ]),
  });
  const more = (n: number): TopicCandidate[] =>
    Array.from({ length: n }, (_, i) => candidate(`r${i + 6}`, { session: "s2" }));
  const small = planTopics(foldTopics([]), [...members, ...more(2)], SETTINGS, 0, vetoed(5));
  expect(small.asks.groups).toEqual([]);
  expect(small.shortfall?.vetoed).toBe(1);
  const grown = planTopics(foldTopics([]), [...members, ...more(3)], SETTINGS, 0, vetoed(5));
  expect(grown.asks.groups.map((g) => g.key)).toEqual(["r1"]);
});

test("a topic made from one group is not proposed for a split until a newer record joins it", () => {
  const at = Date.UTC(2026, 10, 2, 9);
  const held = (text: string, i: number): TopicCandidate =>
    candidate(newUlid(at - 100_000 + i), {
      session: `s${i % 2}`,
      text: `${text} ${i}`,
      at: at - 100_000 + i,
    });
  const garden = [0, 1, 2, 3, 4].map((i) => held("garden watering schedule alley beds", i));
  const shard = [5, 6, 7, 8, 9].map((i) => held("shard compaction monthly files small", i));
  const topic = newUlid(at);
  seedTopicRecord(store, at, TOPIC_CREATE_KIND, topic, { title: "Mixed", scope: "personal" });
  [...garden, ...shard].forEach((c, i) => {
    seedTopicRecord(store, at + 1 + i, "assign", topic, { record: c.id }, { authority: "human" });
  });
  const folded = () =>
    foldTopics(readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records));
  expect(planTopics(folded(), [...garden, ...shard], SETTINGS, at + 20).splits).toEqual([]);
  const newer = candidate(newUlid(at + 30), {
    session: "s3",
    text: "garden watering schedule alley beds",
    at: at + 30,
  });
  seedTopicRecord(store, at + 40, "assign", topic, { record: newer.id }, { authority: "human" });
  const split = planTopics(folded(), [...garden, ...shard, newer], SETTINGS, at + 50).splits;
  expect(split.map((s) => [s.topic, s.groups.map((g) => g.length)])).toEqual([[topic, [6, 5]]]);
});
