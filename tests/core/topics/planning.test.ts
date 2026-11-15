/**
 * Topic planning in dream (task 3.4, spec `topics`): only the view writer
 * plans; it creates a topic from a cluster that recurs across sessions,
 * routes later records to it, lists every automatic action with its undo
 * command, honours the user's undo on every pass after, and only proposes
 * merges, splits and status decisions. A concurrent dream on two machines
 * and two planning processes on the view writer each leave exactly one
 * topic per cluster.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StorePartition } from "../../../src/core/store/constants.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import {
  runTopicPlanning,
  topicPlanLockTarget,
  type TopicPlanningReport,
} from "../../../src/core/topics/planning.ts";
import {
  claimSettled,
  claimViewWriter,
  readViewWriter,
  requestViewWriter,
} from "../../../src/core/view/writer.ts";
import { withLocalLock } from "../../../src/core/store/local-lock.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";
import { seedTopicRecord } from "../view/fixtures/seed.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const DAY = 86_400_000;
let clock = T0;
const now = () => clock;

let m: Machines;
let a: StoreHandle;
beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a", "dev-b"], "o2b-topics-plan-");
  a = m.open("dev-a");
  claimViewWriter(a, { agent: "t", now });
  // The render's first catch-up after the claim, which planning waits for.
  claimSettled(a, readViewWriter(a, now));
});
afterEach(() => m.cleanup());

let seq = 0;
function signal(
  text: string,
  meta: { project?: string; session?: string; on?: StoreHandle; partition?: StorePartition } = {},
): string {
  clock += 1000;
  seq += 1;
  return appendRecord(
    meta.on ?? a,
    {
      partition: meta.partition ?? "shared",
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: `sig-2026-11-02-s${seq}`,
        path: `Brain/inbox/s${seq}.md`,
        staged: false,
        frontmatter: {
          principle: text,
          project: meta.project ?? "o2b",
          ...(meta.session !== undefined ? { session: meta.session } : {}),
        },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now },
  ).record.id;
}

/** Five records about one subject, from the sessions named. */
function cluster(sessions: ReadonlyArray<string>, on: StoreHandle = a): string[] {
  return sessions.map((session, i) =>
    signal(`Shard compaction keeps monthly shard files small ${i}`, { session, on }),
  );
}

/** How many planning children announced they are about to plan. */
function startedChildren(): number {
  return readdirSync(m.parent).filter((n) => n.startsWith("start.")).length;
}

/** Whether a topic-create of dev-a has landed in `shared`. */
function createdOnDisk(): boolean {
  return readPartition(join(m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .some((r) => r.kind === "topic-create");
}

function plan(store: StoreHandle = a): TopicPlanningReport {
  clock += 1000;
  return runTopicPlanning(store, { agent: "dream", now });
}

function planned(report: TopicPlanningReport) {
  if (report.status !== "planned") throw new Error(`not planned: ${report.status}`);
  return report;
}

function fold(device = "dev-a") {
  const records = (["shared", "private"] as const).flatMap((p) =>
    readPartition(join(m.root(device), p)).flatMap((s) => s.records),
  );
  return foldTopics(records);
}

describe("topic planning", () => {
  test("a cluster from two sessions becomes one topic, listed with its undo command", () => {
    const members = cluster(["s1", "s1", "s1", "s2", "s2"]);
    const report = planned(plan());
    expect(report.created).toHaveLength(1);
    const created = report.created[0]!;
    expect(created.title).toBe("Shard compaction keeps");
    expect(created.members).toBe(5);
    expect(created.undo).toBe(`o2b topic undo ${created.record}`);
    const state = fold();
    const topic = state.topics.get(created.topic)!;
    expect(topic.goal).toBe("Shard compaction keeps monthly shard files small 0");
    expect(topic.scope).toBe("project:o2b");
    expect(members.map((id) => state.assignments.get(id))).toEqual(
      members.map(() => created.topic),
    );
    // A second pass finds nothing left to do.
    expect(planned(plan()).created).toEqual([]);
  });

  test("a cluster written without word spaces still becomes a topic, its title cut to fit", () => {
    const longA = "シャードの圧縮".repeat(18);
    const longB = "毎月の小さなファイル".repeat(12);
    const members = ["s1", "s1", "s2", "s2", "s2"].map((session, i) =>
      signal(`${longA}、${longB}、${i}`, { session }),
    );
    const created = planned(plan()).created[0]!;
    const state = fold();
    const topic = state.topics.get(created.topic)!;
    // The record check counts UTF-16 code units: so does the clamp.
    expect(topic.title.length).toBeLessThanOrEqual(200);
    expect(members.map((id) => state.assignments.get(id))).toEqual(
      members.map(() => created.topic),
    );
  });

  test("a cluster in astral-plane characters becomes a topic, its title cut on a whole character", () => {
    // CJK Extension B: two UTF-16 code units per character.
    const longA = "𠀀𠀁𠀂𠀃𠀄𠀅".repeat(30);
    const longB = "𠁀𠁁𠁂𠁃𠁄".repeat(30);
    const members = ["s1", "s1", "s2", "s2", "s2"].map((session, i) =>
      signal(`${longA}、${longB}、${i}`, { session }),
    );
    const report = planned(plan());
    expect(report.created).toHaveLength(1);
    const created = report.created[0]!;
    const state = fold();
    const topic = state.topics.get(created.topic)!;
    expect(topic.title.length).toBeLessThanOrEqual(200);
    expect(topic.title.length).toBeGreaterThanOrEqual(199);
    // No lone surrogate: every character is whole.
    expect(/[\uD800-\uDFFF]/u.test(topic.title)).toBe(false);
    expect(members.map((id) => state.assignments.get(id))).toEqual(
      members.map(() => created.topic),
    );
  });

  test("a private item's words never route a shared record to a topic", () => {
    const id = "01KA0000000000000000000000";
    seedTopicRecord(a, (clock += 1000), "topic-create", id, {
      title: "Unrelated",
      scope: "project:o2b",
    });
    seedTopicRecord(
      a,
      (clock += 1000),
      "decision",
      id,
      { text: "Clinic appointment rescheduling paperwork" },
      { partition: "private" },
    );
    const record = signal("Clinic appointment rescheduling paperwork again", { session: "s9" });
    expect(planned(plan()).routed.map((r) => r.record)).not.toContain(record);
  });

  test("a route taken back from a topic merged away is not taken to the topic it merged into", () => {
    const from = "01KA0000000000000000000007";
    const into = "01KA0000000000000000000008";
    const words = "Clinic appointment rescheduling paperwork";
    seedTopicRecord(a, (clock += 1000), "topic-create", from, {
      title: words,
      scope: "project:o2b",
    });
    seedTopicRecord(a, (clock += 1000), "topic-create", into, {
      title: words,
      scope: "project:o2b",
    });
    const record = signal(`${words} again`, { session: "s9" });
    seedTopicRecord(a, (clock += 1000), "merge", from, { into }, { authority: "human" });
    const assign = seedTopicRecord(a, (clock += 1000), "assign", from, { record });
    seedTopicRecord(a, (clock += 1000), "undo", from, { record: assign }, { authority: "human" });
    expect(planned(plan()).routed.map((r) => r.record)).not.toContain(record);
  });

  test("a private record is routed to a private topic by its private title", () => {
    const id = "01KA0000000000000000000009";
    seedTopicRecord(
      a,
      (clock += 1000),
      "topic-create",
      id,
      { title: "Clinic appointment rescheduling paperwork", scope: "project:o2b" },
      { partition: "private" },
    );
    const record = signal("Clinic appointment rescheduling paperwork again", {
      session: "s9",
      partition: "private",
    });
    const routed = planned(plan()).routed.filter((r) => r.record === record);
    expect(routed.map((r) => r.topic)).toEqual([id]);
    // The assign lands in `private`, beside the record and the topic.
    const assigns = readPartition(join(m.root("dev-a"), "private"))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === "assign" && r.body["record"] === record);
    expect(assigns).toHaveLength(1);
  });

  test("a private title, description or goal never routes a shared record to a topic", () => {
    const words = "Clinic appointment rescheduling paperwork";
    const fields = [
      ["topic-rename", { title: words }],
      ["topic-rename", { description: words }],
      ["topic-goal", { goal: words }],
    ] as const;
    const records: string[] = [];
    for (const [i, [kind, body]] of fields.entries()) {
      const id = `01KA000000000000000000000${i}`;
      seedTopicRecord(a, (clock += 1000), "topic-create", id, {
        title: `Unrelated ${i}`,
        scope: "project:o2b",
      });
      seedTopicRecord(a, (clock += 1000), kind, id, body, { partition: "private" });
      records.push(signal(`${words} again ${i}`, { session: `s${9 + i}` }));
    }
    const routed = planned(plan()).routed.map((r) => r.record);
    expect(routed.filter((r) => records.includes(r))).toEqual([]);
    // The same words in a shared field do route.
    seedTopicRecord(a, (clock += 1000), "topic-goal", "01KA0000000000000000000000", {
      goal: `${words} shared`,
    });
    const late = signal(`${words} shared later`, { session: "s20" });
    expect(planned(plan()).routed.map((r) => r.record)).toContain(late);
  });

  test("a log event whose type names an Object property is not a candidate and breaks nothing", () => {
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "log",
        kind: "log-event",
        agent: "legacy",
        body: {
          timestamp: new Date(clock).toISOString(),
          event_type: "constructor",
          body: { text: "x" },
        },
      },
      { now },
    );
    expect(plan().status).toBe("planned");
  });

  test("one busy session makes no topic until the subject recurs in another session", () => {
    cluster(["s1", "s1", "s1", "s1", "s1", "s1"]);
    expect(planned(plan()).created).toEqual([]);
    signal("Shard compaction keeps monthly shard files small again", { session: "s2" });
    expect(planned(plan()).created).toHaveLength(1);
  });

  test("a later record is routed to the topic; an undone route is never taken again", () => {
    cluster(["s1", "s1", "s2", "s2", "s2"]);
    const topic = planned(plan()).created[0]!.topic;
    const late = signal("Shard compaction should run monthly on each device", { session: "s3" });
    const report = planned(plan());
    expect(report.routed.map((r) => [r.record, r.topic])).toEqual([[late, topic]]);
    seedTopicRecord(
      a,
      (clock += 1000),
      "undo",
      topic,
      { record: report.routed[0]!.assign },
      {
        authority: "human",
      },
    );
    expect(fold().assignments.has(late)).toBe(false);
    expect(planned(plan()).routed).toEqual([]);
    expect(fold().assignments.has(late)).toBe(false);
  });

  test("an agent's undo of an automatic route (as brain_topic writes it) blocks the route too", () => {
    cluster(["s1", "s1", "s2", "s2", "s2"]);
    const topic = planned(plan()).created[0]!.topic;
    const late = signal("Shard compaction should run monthly on each device", { session: "s3" });
    const route = planned(plan()).routed[0]!;
    seedTopicRecord(
      a,
      (clock += 1000),
      "undo",
      topic,
      { record: route.assign },
      { authority: "agent" },
    );
    expect(planned(plan()).routed).toEqual([]);
    expect(fold().assignments.has(late)).toBe(false);
  });

  test("an undone topic is gone and is not created again from the same records", () => {
    cluster(["s1", "s1", "s2", "s2", "s2"]);
    const created = planned(plan()).created[0]!;
    seedTopicRecord(
      a,
      (clock += 1000),
      "undo",
      created.topic,
      { record: created.record },
      {
        authority: "human",
      },
    );
    expect(fold().topics.size).toBe(0);
    expect(planned(plan()).created).toEqual([]);
    expect(fold().topics.size).toBe(0);
  });

  test("a cluster with a private record becomes a private topic", () => {
    cluster(["s1", "s1", "s2", "s2"]);
    signal("Shard compaction keeps monthly shard files small too", {
      session: "s2",
      partition: "private",
    });
    const created = planned(plan()).created[0]!;
    const topicRecords = readPartition(join(m.root("dev-a"), "private"))
      .filter((s) => s.stream === "topics")
      .flatMap((s) => s.records);
    expect(topicRecords.some((r) => r.kind === "topic-create" && r.topic === created.topic)).toBe(
      true,
    );
    const sharedTopicRecords = readPartition(join(m.root("dev-a"), "shared"))
      .filter((s) => s.stream === "topics")
      .flatMap((s) => s.records);
    expect(sharedTopicRecords.filter((r) => r.topic === created.topic)).toEqual([]);
    expect(topicRecords.filter((r) => r.kind === "assign")).toHaveLength(5);
  });

  test("a shared record that carries a <private> region makes its cluster's topic private", () => {
    cluster(["s1", "s1", "s2", "s2"]);
    signal("Shard compaction keeps monthly shard <private>files of Dr. X</private> small", {
      session: "s2",
    });
    const created = planned(plan()).created[0]!;
    const shared = readPartition(join(m.root("dev-a"), "shared"))
      .filter((s) => s.stream === "topics")
      .flatMap((s) => s.records);
    expect(shared.filter((r) => r.topic === created.topic)).toEqual([]);
  });

  test("two topics that look the same are proposed for a merge and both stay as they are", () => {
    const one = "01KA0000000000000000000000";
    const two = "01KA0000000000000000000001";
    for (const id of [one, two]) {
      seedTopicRecord(a, (clock += 1000), "topic-create", id, {
        title: "Shard compaction policy",
        scope: "project:o2b",
        goal: "Monthly shard compaction",
      });
    }
    const report = planned(plan());
    expect(report.merges.map((p) => p.topics)).toEqual([[one, two]]);
    const state = fold();
    expect([state.topics.get(one)!.mergedInto, state.topics.get(two)!.mergedInto]).toEqual([
      null,
      null,
    ]);
  });

  test("a quiet active topic is offered for a status decision; its status does not change", () => {
    const id = "01KA0000000000000000000000";
    seedTopicRecord(a, clock, "topic-create", id, { title: "Old work", scope: "project:o2b" });
    clock += 31 * DAY;
    const report = planned(plan());
    expect(report.quiet).toEqual([{ topic: id, days: 31 }]);
    expect(fold().topics.get(id)!.status).toBe("active");
  });

  test("a topic whose records fall into two clusters is proposed for a split", () => {
    const id = "01KA0000000000000000000000";
    seedTopicRecord(a, (clock += 1000), "topic-create", id, {
      title: "Mixed",
      scope: "project:o2b",
    });
    const records = [
      ...cluster(["s1", "s1", "s2", "s2", "s2"]),
      ...["s3", "s3", "s4", "s4", "s4"].map((session, i) =>
        signal(`Phone views render markdown pages offline ${i}`, { session }),
      ),
    ];
    for (const record of records) {
      seedTopicRecord(a, (clock += 1000), "assign", id, { record }, { authority: "human" });
    }
    const report = planned(plan());
    expect(report.splits.map((s) => [s.topic, s.groups.map((g) => g.length)])).toEqual([
      [id, [5, 5]],
    ]);
    expect(report.created).toEqual([]);
  });

  test("dream on two machines at once: only the view writer creates, and one topic exists", () => {
    const b = m.open("dev-b");
    cluster(["s1", "s1", "s2", "s2", "s2"], b);
    m.sync();
    const onB = plan(b);
    expect(onB).toEqual({ status: "not-writer", writer: "dev-a" });
    expect(planned(plan()).created).toHaveLength(1);
    m.sync();
    expect(plan(b)).toEqual({ status: "not-writer", writer: "dev-a" });
    expect(fold("dev-b").topics.size).toBe(1);
    expect(fold("dev-a").topics.size).toBe(1);
  });

  test("planning waits for the claim to settle, and hands the role over on a request", () => {
    const fresh = makeMachines(["dev-c", "dev-d"], "o2b-topics-plan-gate-");
    try {
      const c = fresh.open("dev-c");
      claimViewWriter(c, { agent: "t", now });
      cluster(["s1", "s1", "s2", "s2", "s2"], c);
      expect(plan(c)).toEqual({ status: "waiting-for-claim" });
      fresh.sync();
      const d = fresh.open("dev-d");
      requestViewWriter(d, { agent: "t", now, force: false });
      fresh.sync();
      expect(plan(c)).toEqual({ status: "released", to: "dev-d" });
      const records = (["shared", "private"] as const).flatMap((p) =>
        readPartition(join(fresh.root("dev-c"), p)).flatMap((s) => s.records),
      );
      expect(foldTopics(records).topics.size).toBe(0);
    } finally {
      fresh.cleanup();
    }
  });

  test("a writer move that arrives while the pass holds the planning lock stops it before it plans", () => {
    cluster(["s1", "s1", "s2", "s2", "s2"]);
    m.sync();
    const b = m.open("dev-b");
    const lock = `${topicPlanLockTarget(a)}.lock`;
    let moved = false;
    clock += 1000;
    const report = runTopicPlanning(a, {
      agent: "dream",
      // The first clock reading under the lock comes after the gate read
      // the settings: the move lands between that read and the plan's.
      now: () => {
        if (!moved && existsSync(lock)) {
          moved = true;
          requestViewWriter(b, { agent: "t", now, force: true });
          m.deliver("dev-b", "dev-a");
        }
        return clock;
      },
    });
    expect(moved).toBe(true);
    expect(report).toEqual({ status: "not-writer", writer: "dev-b" });
    expect(fold().topics.size).toBe(0);
  });

  test("a write that fails after a topic was created still lists the topic with its undo command", () => {
    cluster(["s1", "s1", "s2", "s2", "s2"]);
    clock += 1000;
    const report = runTopicPlanning(a, {
      agent: "dream",
      // A clock that fails once the create has landed: the first assign fails.
      now: () => {
        if (createdOnDisk()) throw new Error("clock unavailable");
        return clock;
      },
    });
    expect(report.status).toBe("error");
    if (report.status !== "error") return;
    expect(report.error).toBe("clock unavailable");
    expect(report.created.map((c) => [c.members, c.undo])).toEqual([
      [0, `o2b topic undo ${report.created[0]!.record}`],
    ]);
    expect(fold().topics.size).toBe(1);
  });

  test("two planning processes on the view writer wait for the lock and leave one topic per cluster", async () => {
    cluster(["s1", "s1", "s2", "s2", "s2"]);
    ["s3", "s3", "s4", "s4", "s4"].forEach((session, i) =>
      signal(`Phone views render markdown pages offline ${i}`, { session }),
    );
    const start = join(m.parent, "start");
    const children = [0, 1].map(() =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures", "plan-child.ts"),
          m.root("dev-a"),
          "dev-a",
          m.parent,
          start,
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          // Shorter than the time the lock is held: planning must wait longer.
          env: { ...process.env, OPEN_SECOND_BRAIN_LOCK_WAIT_MS: "200" },
        },
      ),
    );
    // Hold the planning lock while both children start, so both must wait on it.
    let released = 0;
    withLocalLock(topicPlanLockTarget(a), () => {
      writeFileSync(start, "");
      // Release only once both children are about to plan, so both meet the held lock.
      const deadline = Date.now() + 20_000;
      while (startedChildren() < 2 && Date.now() < deadline) Bun.sleepSync(10);
      expect(startedChildren()).toBe(2);
      Bun.sleepSync(300);
      released = Date.now();
    });
    const outs = await Promise.all(children.map((c) => new Response(c.stdout).text()));
    await Promise.all(children.map((c) => c.exited));
    const results = outs.map(
      (o) => JSON.parse(o) as { report?: { status: string; created: unknown[] }; end: number },
    );
    for (const result of results) {
      expect(result.report?.status).toBe("planned");
      expect(result.end).toBeGreaterThanOrEqual(released);
    }
    expect(results.flatMap((r) => r.report!.created)).toHaveLength(2);
    expect(fold().topics.size).toBe(2);
  });
});
