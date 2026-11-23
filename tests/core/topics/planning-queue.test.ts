/**
 * Topic planning applies the answers of the closed questions (change
 * `dream-closed-questions`, design D2, D5; spec "The fixed rule does not
 * answer in place of a model", "Answers are applied through the existing
 * writes, once", "Topic judgment and topic planning run on the dream
 * owner's device", task 5.1).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { readPartition } from "../../../src/core/store/state-digest.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_MILESTONE_KIND,
  TOPIC_QUESTION_KIND,
} from "../../../src/core/topics/constants.ts";
import { readTopicReview } from "../../../src/core/topics/review.ts";
import { runTopicAction } from "../../../src/core/topics/actions.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
import { takeDreamOwner } from "../../../src/core/brain/dream-owner/owner.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import * as dreamQueue from "../../../src/core/brain/dream-queue/queue.ts";
import {
  claimSettled as claimViewSettled,
  claimViewWriter,
  readViewWriter,
} from "../../../src/core/view/writer.ts";
import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
} from "../../../src/core/brain/dream-owner/owner.ts";
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

function records(kind: string) {
  return [
    ...readPartition(join(f.m.root("dev-a"), "shared")),
    ...readPartition(join(f.m.root("dev-a"), "private")),
  ]
    .flatMap((s) => s.records)
    .filter((r) => r.kind === kind);
}

function fake(answer: (id: string) => string | number | undefined, probability = 0.9) {
  return new FakeDecisionProvider({ answer, probability, model: "enforce-model-3" });
}

function garden(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    f.signal(`Alley garden beds watering notes from meeting ${i}`, { session: `s${i % 2}` }),
  );
}

describe("accepted answers become today's writes", () => {
  test("landed topic effects remain in the report when queue bookkeeping fails", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTopic = f.seedTopic("Garden watering schedule for the alley beds");
    const record = f.signal("Shard compaction and garden watering schedules were tuned today");
    f.tune("topic_route", { route_min: 0.6 });
    await ask(
      f,
      "topic_route:enforce",
      fake((id) => (id.startsWith("route_") ? "T1" : undefined)),
    );
    const mark = spyOn(dreamQueue, "markAppliedByPlanning").mockImplementation(() => {
      throw new Error("queue write failed");
    });
    let report;
    try {
      report = plan(f);
    } finally {
      mark.mockRestore();
    }
    expect(report.status).toBe("error");
    if (report.status !== "error") return;
    expect(report.applied).toBe(1);
    expect(report.routed).toHaveLength(1);
    expect(report.routed[0]).toMatchObject({ record, topic: gardenTopic });
    expect(report.routed[0]?.undo).toContain("o2b topic undo");
  });

  test("a route answer routes the record, with the model as author, and marks its item applied", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const gardenTopic = f.seedTopic("Garden watering schedule for the alley beds");
    const record = f.signal("Shard compaction and garden watering schedules were tuned today");
    f.tune("topic_route", { route_min: 0.6 });
    await ask(
      f,
      "topic_route:enforce",
      fake((id) => (id.startsWith("route_") ? "T1" : undefined)),
    );
    const report = plan(f);
    expect(report.status).toBe("planned");
    const assigns = records(TOPIC_ASSIGN_KIND);
    expect(assigns).toHaveLength(1);
    expect(assigns[0]!.topic).toBe(gardenTopic);
    expect(assigns[0]!.body).toMatchObject({
      authority: "model",
      record,
      verdict: {
        use: "topic_route",
        model: "enforce-model-3",
        provider: "compatible",
        confidence: 0.9,
      },
    });
    const [item] = f.items("topic-route");
    expect(item!.state).toBe("finished");
    expect(item!.applied?.effects).toEqual([assigns[0]!.id]);
  });

  test("an approved group is created with the verdict; a group with no answer is not", async () => {
    const members = garden(5);
    const before = plan(f);
    expect(before.status === "planned" && before.created).toEqual([]);
    f.tune("topic_new", { veto_below: 0.3 });
    await ask(
      f,
      "topic_new:enforce",
      fake((id) => (id.startsWith("new_") ? 0.9 : undefined)),
    );
    const report = plan(f);
    expect(report.status === "planned" && report.created).toHaveLength(1);
    const creates = records(TOPIC_CREATE_KIND);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body["verdict"]).toMatchObject({ use: "topic_new", confidence: 0.9 });
    expect(
      records(TOPIC_ASSIGN_KIND)
        .map((r) => r.body["record"])
        .toSorted(),
    ).toEqual(members.toSorted());
    expect(f.items("topic-new")[0]!.applied?.effects).toEqual([creates[0]!.id]);
  });

  test("kinds, resolutions, completions and history verdicts are written as before", async () => {
    const topic = f.seedTopic("Shard compaction");
    const question = f.seedItem(topic, TOPIC_QUESTION_KIND, { text: "How often to compact?" });
    const milestone = f.seedItem(topic, TOPIC_MILESTONE_KIND, { text: "Ship monthly compaction" });
    const record = f.signal("We decided compaction runs monthly; it shipped");
    f.holdRecord(topic, record);
    const note = f.note("Compaction shipped this week");
    for (const [use, name] of [
      ["event_kind", "kind_min"],
      ["question_resolved", "resolved_min"],
      ["milestone_done", "done_min"],
      ["human_readable", "hide_below"],
    ] as const) {
      f.tune(use, { [name]: name === "hide_below" ? 0.3 : 0.7 });
    }
    const provider = fake((id) =>
      id.startsWith("kind_")
        ? "decision"
        : id.startsWith("answers_")
          ? "Q0"
          : id.startsWith("done_")
            ? 0.9
            : id.startsWith("history_")
              ? 0.1
              : undefined,
    );
    await ask(
      f,
      "event_kind:enforce,question_resolved:enforce,milestone_done:enforce,human_readable:enforce",
      provider,
    );
    const report = plan(f);
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.derived).toBe(1);
    expect(report.resolutions).toBe(1);
    expect(report.completions).toBe(1);
    expect(report.hidden).toBe(1);
    expect(records("decision")[0]!.body).toMatchObject({ authority: "model", item: record });
    expect(records("question-resolved")[0]!.body).toMatchObject({ question, source: record });
    expect(records("milestone-done")[0]!.body).toMatchObject({ milestone });
    expect(records("history-verdict")[0]!.body).toMatchObject({ record: note, keep: false });
    for (const item of f.items()) expect(item.state).toBe("finished");
  });
});

describe("abstaining", () => {
  test("an answer below its threshold finishes the item as abstained and writes nothing", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.signal("Shard compaction thresholds were tuned today");
    f.tune("topic_route", { route_min: 0.6 });
    await ask(
      f,
      "topic_route:enforce",
      fake((id) => (id.startsWith("route_") ? "T0" : undefined), 0.5),
    );
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(1);
    expect(records(TOPIC_ASSIGN_KIND)).toEqual([]);
    expect(f.items("topic-route")[0]!.applied?.effects).toEqual(["abstained"]);
    // Asked once: the next pass asks nothing for the same input.
    const again = fake((id) => (id.startsWith("route_") ? "T0" : undefined));
    await ask(f, "topic_route:enforce", again);
    expect(again.requests).toEqual([]);
  });

  test("topic-new and human-readable never abstain: a low answer vetoes and hides", async () => {
    garden(5);
    const note = f.note("Heartbeat");
    f.tune("topic_new", { veto_below: 0.3 });
    f.tune("human_readable", { hide_below: 0.3 });
    await ask(
      f,
      "topic_new:enforce,human_readable:enforce",
      fake(() => 0.1),
    );
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(0);
    expect(records(TOPIC_CREATE_KIND)).toEqual([]);
    expect(records("history-verdict")[0]!.body).toMatchObject({ record: note, keep: false });
    expect(f.items("topic-new")[0]!.applied?.effects).toEqual(["veto"]);
  });
});

describe("once, and only for the current subject", () => {
  test("planning twice writes once", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.signal("Shard compaction thresholds were tuned today");
    f.tune("topic_route", { route_min: 0.6 });
    await ask(
      f,
      "topic_route:enforce",
      fake((id) => (id.startsWith("route_") ? "T0" : undefined)),
    );
    plan(f);
    plan(f);
    expect(records(TOPIC_ASSIGN_KIND)).toHaveLength(1);
  });

  test("an answer whose record a person assigned meanwhile is not applied", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const other = f.seedTopic("Garden watering schedule for the alley beds");
    const record = f.signal("Shard compaction and garden watering schedules were tuned today");
    f.tune("topic_route", { route_min: 0.6 });
    await ask(
      f,
      "topic_route:enforce",
      fake((id) => (id.startsWith("route_") ? "T0" : undefined)),
    );
    f.holdRecord(other, record);
    plan(f);
    expect(records(TOPIC_ASSIGN_KIND)).toHaveLength(1);
    const [item] = f.items("topic-route");
    expect(item!.state).toBe("closed");
  });
});

describe("standing verdicts", () => {
  test("a veto holds in the next pass and nothing is asked again", async () => {
    garden(5);
    f.tune("topic_new", { veto_below: 0.3 });
    await ask(
      f,
      "topic_new:enforce",
      fake(() => 0.1),
    );
    plan(f);
    const again = fake(() => 0.9);
    await ask(f, "topic_new:enforce", again);
    expect(again.requests).toEqual([]);
    const report = plan(f);
    expect(report.status === "planned" && report.created).toEqual([]);
    expect(report.status === "planned" && report.shortfalls[0]?.vetoed).toBe(1);
  });

  test("a none route keeps the record free in the next pass and nothing is asked again", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = f.signal("Shard compaction of monthly shard files ran long today");
    f.tune("topic_route", { route_min: 0.6 });
    await ask(
      f,
      "topic_route:enforce",
      fake((id) => (id.startsWith("route_") ? "none" : undefined)),
    );
    plan(f);
    expect(f.items("topic-route")[0]!.applied?.effects).toEqual(["none"]);
    const again = fake((id) => (id.startsWith("route_") ? "T0" : undefined));
    await ask(f, "topic_route:enforce", again);
    expect(again.requests).toEqual([]);
    plan(f);
    expect(records(TOPIC_ASSIGN_KIND).filter((r) => r.body["record"] === record)).toEqual([]);
  });

  test("a same hint is shown by the review listing from both callers in a later pass", async () => {
    const a = f.seedTopic("Shard compaction window tuning");
    const b = f.seedTopic("Shard compaction window settings");
    f.tune("topic_same", { same_min: 0.7 });
    await ask(
      f,
      "topic_same:enforce",
      fake((id) => (id.startsWith("pair_") ? "same" : undefined)),
    );
    plan(f);
    const read = readTopicReview(f.still(), f.configPath);
    expect(read?.review.merges.map((m) => [m.topics, m.judged])).toEqual([[[a, b], "same"]]);
    const viaTool = await runTopicAction(
      { action: "review" },
      { configPath: f.configPath, now: f.still },
    );
    expect(JSON.stringify(viaTool)).toContain('"judged":"same"');
  });
});

describe("no answer", () => {
  test("a record stays unassigned and a qualifying group is not created", () => {
    f.seedTopic("Alley garden beds watering");
    const routed = f.signal("Alley garden beds watering notes from meeting zero");
    const report = plan(f);
    expect(report.status === "planned" && report.routed).toEqual([]);
    expect(records(TOPIC_ASSIGN_KIND).filter((r) => r.body["record"] === routed)).toEqual([]);
  });
});

describe("who plans", () => {
  test("only the dream owner's device plans; another device plans nothing and says so", () => {
    f.m.sync();
    const b = f.m.open("dev-b");
    const report = runTopicPlanning(b, { agent: "dream", now: f.now });
    expect(report).toEqual({ status: "not-owner", owner: "dev-a" });
  });

  test("a forced takeover that lands after the gate stops planning before its first write", () => {
    f.seedTopic("Alley garden beds watering");
    f.signal("Alley garden beds watering notes from meeting zero");
    const before = records(TOPIC_ASSIGN_KIND).length;
    const real = dreamQueue.readDreamWork;
    let taken = false;
    const spy = spyOn(dreamQueue, "readDreamWork").mockImplementation((...args) => {
      if (!taken) {
        taken = true;
        takeDreamOwner(openStore({ root: f.a.root, device: "dev-b" }), "codex", {
          writer: "o2b",
          authority: "human",
          force: true,
        });
      }
      return real(...args);
    });
    try {
      expect(plan(f)).toEqual({ status: "not-owner", owner: "dev-b" });
    } finally {
      spy.mockRestore();
    }
    expect(taken).toBe(true);
    expect(records(TOPIC_ASSIGN_KIND).length).toBe(before);
  });

  test("a brain with no owner bound plans under the view writer gate and decides nothing", () => {
    f.cleanup();
    f = closedFixture({ bindOwner: false });
    claimViewWriter(f.a, { agent: "dream", now: f.now });
    claimViewSettled(f.a, readViewWriter(f.a, f.now));
    f.seedTopic("Alley garden beds watering");
    f.signal("Alley garden beds watering notes from meeting zero");
    garden(5);
    const report = plan(f);
    expect(report.status).toBe("planned");
    expect(report.status === "planned" && report.judgment).toBe("unbound");
    expect(records(TOPIC_ASSIGN_KIND)).toEqual([]);
    expect(records(TOPIC_CREATE_KIND).filter((r) => r.agent === "dream")).toEqual([]);
    void claimDreamOwner;
    void claimSettled;
    void readDreamOwner;
  });
});
