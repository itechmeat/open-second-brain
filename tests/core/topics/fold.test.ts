/**
 * The topic fold's rules (task 3.1, design D8, spec `topics`): a rename
 * keeps the id and every reference, human edits win and the losing agent
 * goal stays as a proposal, completion needs the user or evidence, undo
 * voids a record and blocks the route it took back, merges resolve, and
 * malformed records are reported rather than applied.
 */
import { describe, expect, test } from "bun:test";

import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldTopics, routeKey, topicOfRecord } from "../../../src/core/topics/fold.ts";
import { topicCorrection } from "../../../src/core/view/topic-edits.ts";
import { rec, seededRandom, seededUlid } from "../store/fixtures/fold-records.ts";

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const ids = seededRandom(5);
const TOPIC = seededUlid(ids, T0);
const OTHER = seededUlid(ids, T0 + 1);
const EVENT = seededUlid(ids, T0 + 2);

let clock = T0;
function topicRec(
  kind: string,
  body: Record<string, unknown>,
  opts: { topic?: string; agent?: string; authority?: string; device?: string } = {},
): StoreRecord {
  clock += 1000;
  return rec({
    physical: clock,
    kind,
    topic: opts.topic ?? TOPIC,
    agent: opts.agent ?? "agent-1",
    device: opts.device ?? "dev-a",
    body: { authority: opts.authority ?? "agent", ...body },
  });
}

const create = (topic = TOPIC, title = "Store migration") =>
  topicRec("topic-create", { title, scope: "project:o2b", goal: "Move the brain out" }, { topic });

describe("topic fold", () => {
  test("a rename keeps the id, the items, the assignments, the links and the record's topic", () => {
    const records = [
      create(),
      create(OTHER, "Docs"),
      topicRec("decision", { item: "d1", text: "Keep JSONL shards" }),
      topicRec("assign", { record: EVENT }),
      topicRec("link", { to: OTHER }),
      topicRec(
        "topic-rename",
        { title: "Brain store", description: "Data outside the vault" },
        { authority: "human" },
      ),
    ];
    const event = rec({ physical: T0 + 5, kind: "log-event", topic: TOPIC, body: { x: 1 } });
    const fold = foldTopics(records);
    const topic = fold.topics.get(TOPIC)!;
    expect(topic.title).toBe("Brain store");
    expect(topic.description).toBe("Data outside the vault");
    expect(topic.createdAt).toBe(records[0]!.hlc.split(".").map(Number)[0]!);
    expect(topic.items.map((i) => [i.id, i.text])).toEqual([["d1", "Keep JSONL shards"]]);
    expect(fold.assignments.get(EVENT)).toBe(TOPIC);
    expect(fold.topics.get(OTHER)!.links).toEqual([TOPIC]);
    expect(topicOfRecord(fold, event)).toBe(TOPIC);
  });

  test("an agent's status change applies to a topic the user created; a later human one wins", () => {
    const made = topicRec(
      "topic-create",
      { title: "Mine", scope: "project:o2b" },
      { authority: "human" },
    );
    const fold = (extra: StoreRecord[]) => foldTopics([made, ...extra]).topics.get(TOPIC)!.status;
    const agent = topicRec("topic-status", { status: "waiting" });
    expect(fold([agent])).toBe("waiting");
    const human = topicRec("topic-status", { status: "blocked" }, { authority: "human" });
    const laterAgent = topicRec("topic-status", { status: "done" });
    expect(fold([agent, human, laterAgent])).toBe("blocked");
  });

  test("the user's goal wins, and a later agent goal is kept as a proposal", () => {
    const fold = foldTopics([
      create(),
      topicRec("topic-goal", { goal: "Ship phase 3" }, { authority: "human" }),
      topicRec("topic-goal", { goal: "Ship everything" }, { agent: "planner" }),
    ]);
    const topic = fold.topics.get(TOPIC)!;
    expect(topic.goal).toBe("Ship phase 3");
    expect(topic.goalProposals.map((p) => [p.agent, p.goal])).toEqual([
      ["planner", "Ship everything"],
    ]);
  });

  test("a milestone is done only by the user or an agent that cites evidence", () => {
    const fold = foldTopics([
      create(),
      topicRec("milestone", { item: "m1", text: "Topics render" }),
      topicRec("milestone", { item: "m2", text: "Docs written" }),
      topicRec("milestone", { item: "m3", text: "Release" }),
      topicRec("milestone-done", { milestone: "m1" }, { authority: "model" }),
      topicRec("milestone-done", { milestone: "m2" }),
      topicRec("milestone-done", { milestone: "m3", evidence: "CI run 41 green" }),
    ]);
    const [m1, m2, m3] = fold.topics.get(TOPIC)!.items;
    expect(m1!.done).toBeUndefined();
    expect(m1!.doneProposed?.authority).toBe("model");
    expect(m2!.done).toBeUndefined();
    expect(m2!.doneProposed?.authority).toBe("agent");
    expect(m3!.done?.evidence).toBe("CI run 41 green");
  });

  test("an undo voids the record; a human undo of an assign blocks that route", () => {
    const assign = topicRec("assign", { record: EVENT }, { authority: "model" });
    const fold = foldTopics([
      create(),
      assign,
      topicRec("undo", { record: assign.id }, { authority: "human" }),
    ]);
    expect(fold.voided.has(assign.id)).toBe(true);
    expect(fold.assignments.has(EVENT)).toBe(false);
    expect(fold.blockedRoutes.has(routeKey(EVENT, TOPIC))).toBe(true);
  });

  test("an agent cannot undo the user's record; an undone create removes the topic", () => {
    const human = topicRec(
      "decision",
      { item: "d1", text: "Chosen by hand" },
      { authority: "human" },
    );
    const made = create(OTHER, "Auto topic");
    const fold = foldTopics([
      create(),
      human,
      topicRec("undo", { record: human.id }),
      made,
      topicRec("undo", { record: made.id }, { authority: "human", topic: OTHER }),
    ]);
    expect(fold.topics.get(TOPIC)!.items.map((i) => i.id)).toEqual(["d1"]);
    expect(fold.topics.has(OTHER)).toBe(false);
  });

  test("a merged topic resolves to its target, whose page carries both topics' items", () => {
    const fold = foldTopics([
      create(),
      create(OTHER, "Docs"),
      topicRec("decision", { item: "d1", text: "Write the guide" }, { topic: OTHER }),
      topicRec("merge", { into: TOPIC }, { topic: OTHER, authority: "human" }),
      // The reverse merge would close a cycle and is ignored.
      topicRec("merge", { into: OTHER }, { authority: "human" }),
    ]);
    expect(fold.canonical(OTHER)).toBe(TOPIC);
    expect(fold.canonical(TOPIC)).toBe(TOPIC);
    expect(fold.topics.get(OTHER)!.mergedInto).toBe(TOPIC);
    expect(fold.topics.get(TOPIC)!.items.map((i) => i.id)).toEqual(["d1"]);
  });

  test("an item id is its topic's own: the same token in two topics names two items", () => {
    const fold = foldTopics([
      create(),
      create(OTHER, "Docs"),
      topicRec("milestone", { item: "m1", text: "A milestone" }),
      topicRec("milestone", { item: "m1", text: "B milestone" }, { topic: OTHER }),
      topicRec("milestone-done", { milestone: "m1" }, { authority: "human" }),
      topicRec("decision", { item: "m1", removed: true }, { topic: OTHER }),
    ]);
    const show = (id: string) =>
      fold.topics.get(id)!.items.map((i) => [i.text, i.done !== undefined]);
    expect(show(TOPIC)).toEqual([["A milestone", true]]);
    expect(show(OTHER)).toEqual([["B milestone", false]]);
    expect(fold.rejected).toHaveLength(1);
  });

  test("a split moves the items it lists to the other topic", () => {
    const fold = foldTopics([
      create(),
      create(OTHER, "Docs"),
      topicRec("decision", { item: "d1", text: "One" }),
      topicRec("decision", { item: "d2", text: "Two" }),
      topicRec("split", { into: OTHER, items: ["d2"] }, { authority: "human" }),
    ]);
    expect(fold.topics.get(TOPIC)!.items.map((i) => i.id)).toEqual(["d1"]);
    expect(fold.topics.get(OTHER)!.items.map((i) => i.id)).toEqual(["d2"]);
  });

  test("a done status carries its resolved day; malformed records are reported, not applied", () => {
    const bad = topicRec("topic-status", { status: "sideways" });
    const fold = foldTopics([
      create(),
      topicRec("topic-status", { status: "done" }, { authority: "human" }),
      bad,
    ]);
    const topic = fold.topics.get(TOPIC)!;
    expect(topic.status).toBe("done");
    expect(topic.resolved).toBe("2026-11-01");
    expect(fold.rejected.map((r) => r.id)).toEqual([bad.id]);
  });

  test("the reader's private record ids mark a private topic and a private item", () => {
    const made = create();
    const secret = topicRec("open-question", { item: "q1", text: "Ask about leave" });
    const fold = foldTopics([made, secret], { privateIds: new Set([secret.id]) });
    const topic = fold.topics.get(TOPIC)!;
    expect(topic.private).toBe(false);
    expect(topic.items[0]!.private).toBe(true);
  });
  test("a decision reworded on its page keeps the milestones it serves; an empty list clears them", () => {
    const records = [
      create(),
      topicRec("milestone", { item: "m1", text: "Store core released" }),
      topicRec("decision", { item: "d1", text: "Keep JSONL shards", serves: ["m1"] }),
    ];
    const edit = topicCorrection(
      `t:${TOPIC}:d:d1`,
      "- Keep JSONL shards (serves: Store core released)",
      "- Keep one JSONL shard per month (serves: Store core released)",
    )!;
    expect(edit[0]!.body["serves"]).toBeUndefined();
    const reworded = topicRec(edit[0]!.kind, edit[0]!.body);
    const decision = (extra: StoreRecord[]) =>
      foldTopics([...records, reworded, ...extra])
        .topics.get(TOPIC)!
        .items.find((i) => i.id === "d1")!;
    expect(decision([])).toMatchObject({ text: "Keep one JSONL shard per month", serves: ["m1"] });
    const cleared = topicRec(
      "decision",
      { item: "d1", text: "Unlinked", serves: [] },
      { authority: "human" },
    );
    expect(decision([cleared]).serves).toEqual([]);
  });

  test("a merged topic's item edit and a split's received items count as activity of the topic that shows them", () => {
    const target = seededUlid(ids, T0 + 3);
    const merge = [
      create(),
      create(OTHER, "Docs"),
      topicRec("decision", { item: "d1", text: "From the store topic" }),
      topicRec("merge", { into: OTHER }, { authority: "human" }),
    ];
    const edit = topicRec("decision", { item: "d1", text: "Edited through Docs" });
    expect(foldTopics([...merge, edit]).topics.get(OTHER)!.updatedAt).toBe(
      Number(edit.hlc.split(".")[0]),
    );
    const received = [
      create(),
      create(target, "Target"),
      topicRec("decision", { item: "d2", text: "Moves" }),
    ];
    const split = topicRec("split", { into: target, items: ["d2"] }, { authority: "human" });
    expect(foldTopics([...received, split]).topics.get(target)!.updatedAt).toBe(
      Number(split.hlc.split(".")[0]),
    );
  });
});
