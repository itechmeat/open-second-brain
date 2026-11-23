/**
 * `topic_new` as a queue item (change `dream-closed-questions`; was the
 * decide pass, task 4.1, design D10): a qualifying group is created only
 * on an approval; `off` and `shadow` leave the item waiting and create
 * nothing; an enforced answer at or above `veto_below` approves and the
 * create carries the verdict, one below vetoes; a timeout leaves the item
 * waiting; a group below the thresholds is never asked about.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { TOPIC_CREATE_KIND } from "../../../src/core/topics/constants.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import { ask, plan, planAndWord } from "./fixtures/closed-run.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

/** A qualifying cluster: five records of one subject, two sessions. */
function cluster(): string[] {
  return [
    f.signal("Deprecation windows for the public API start next quarter", { session: "s1" }),
    f.signal("Deprecation windows for the public API were drafted", { session: "s1" }),
    f.signal("Deprecation windows for the public API got reviewed", { session: "s2" }),
    f.signal("Deprecation windows for the public API were approved", { session: "s2" }),
    f.signal("Deprecation windows for the public API announced today", { session: "s2" }),
  ];
}

function fresh(p: number, extra: { model?: string; fail?: "timeout" } = {}) {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("new_") ? p : undefined),
    ...extra,
  });
}

function creates(): Array<Record<string, unknown>> {
  return readPartition(join(f.m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === TOPIC_CREATE_KIND)
    .map((r) => r.body);
}

describe("topic_new on the queue", () => {
  test("off sends nothing, the create waits for an answer and nothing is written", async () => {
    cluster();
    const fake = fresh(0.9);
    await ask(f, "topic_new:off", fake);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(f.vault)).toEqual([]);
    const report = plan(f);
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.created).toEqual([]);
    expect(creates()).toEqual([]);
    expect(f.items("topic-new").map((i) => i.state)).toEqual(["waiting"]);
  });

  test("shadow asks once, records the call, and no create is written", async () => {
    cluster();
    const fake = fresh(0.9, { model: "shadow-model-2" });
    await ask(f, "topic_new:shadow", fake);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("topic_new");
    const state = fake.requests[0]!.state as { title: string; groups: Record<string, string> };
    expect(state.title.toLowerCase()).toContain("deprecation");
    expect(Object.keys(state.groups)).toHaveLength(5);
    const calls = listDecisionModelCalls(f.vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(calls[0]!.payload["p_yes"]).toBe(0.9);
    const report = plan(f);
    expect(report.status).toBe("planned");
    expect(creates()).toEqual([]);
  });

  test("enforce approval writes the create with the verdict", async () => {
    cluster();
    f.tune("topic_new", { veto_below: 0.3 });
    await ask(f, "topic_new:enforce", fresh(0.9, { model: "approve-model-4" }));
    const report = planAndWord(f);
    expect(report.status).toBe("planned");
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!["verdict"]).toEqual({
      use: "topic_new",
      model: "approve-model-4",
      provider: "compatible",
      version: 1,
      mode: "enforce",
      confidence: 0.9,
    });
    expect(creates()[0]!["authority"]).toBe("agent");
  });

  test("enforce below veto_below vetoes the creation", async () => {
    cluster();
    f.tune("topic_new", { veto_below: 0.3 });
    await ask(f, "topic_new:enforce", fresh(0.2));
    const report = plan(f);
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.created).toEqual([]);
    expect(creates()).toEqual([]);
    expect(f.items("topic-new")[0]!.applied?.effects).toEqual(["veto"]);
  });

  test("a group below the thresholds is never asked about and never created", async () => {
    // Two records from one session: below minSessions, whatever p(yes) is.
    f.signal("Deprecation windows for the public API start next quarter", { session: "s1" });
    f.signal("Deprecation windows for the public API were drafted", { session: "s1" });
    f.tune("topic_new", { veto_below: 0.3 });
    const fake = fresh(1);
    await ask(f, "topic_new:enforce", fake);
    expect(fake.requests).toEqual([]);
    expect(f.items("topic-new")).toEqual([]);
    const report = plan(f);
    expect(report.status).toBe("planned");
    expect(report.status === "planned" ? report.created : []).toEqual([]);
    expect(creates()).toEqual([]);
  });

  test("a timeout leaves the item waiting with a retry time and creates nothing", async () => {
    cluster();
    f.tune("topic_new", { veto_below: 0.3 });
    await ask(f, "topic_new:enforce", fresh(0.2, { fail: "timeout" }));
    const [item] = f.items("topic-new");
    expect(item!.attempts).toBe(1);
    expect(item!.retry_at).not.toBe(null);
    const report = plan(f);
    expect(report.status).toBe("planned");
    expect(creates()).toEqual([]);
  });
});

describe("veto_below from the thresholds store", () => {
  test("a stored veto_below under the answer decides, not the built-in default", async () => {
    cluster();
    f.tune("topic_new", { veto_below: 0.05 });
    await ask(f, "topic_new:enforce", fresh(0.1));
    planAndWord(f);
    // The built-in 0.3 would veto at 0.1; the stored 0.05 decides.
    expect(creates()).toHaveLength(1);
  });
});
