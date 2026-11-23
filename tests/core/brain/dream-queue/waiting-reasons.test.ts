/**
 * Why closed questions wait, as the surfaces show it (change
 * `dream-closed-questions`, design D7; spec "Waiting is visible and
 * explained"): the reasons are derived from the queue's records and this
 * machine's decision model settings, grouped per operation with the
 * count and the oldest age; doctor names the setting that answers an
 * operation nothing answers (`dream-queue-no-executor`, per operation)
 * and explains every waiting closed question (`dream-questions-waiting`).
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dreamQueueCheck } from "../../../../src/core/brain/doctor/dream-queue-check.ts";
import type { DoctorFindings } from "../../../../src/core/brain/doctor/check.ts";
import {
  queueStatusAt,
  releaseWork,
  takeWork,
} from "../../../../src/core/brain/dream-queue/queue.ts";
import { RELEASE_COST_GATE } from "../../../../src/core/brain/dream-queue/decision-executor.ts";
import {
  describeQueueStatus,
  waitingByOperation,
} from "../../../../src/core/brain/dream-queue/status-view.ts";
import { dayCompletion, readQueueFacts } from "../../../../src/core/brain/dream-trigger/outcome.ts";
import { resolveDreamAgentConfig } from "../../../../src/core/brain/dream-queue/agent-config.ts";
import { recordDreamAgentVerification } from "../../../../src/core/brain/dream-queue/agent-verified.ts";
import { FakeDecisionProvider } from "../../../helpers/fake-decision-provider.ts";
import { closedFixture, type ClosedFixture } from "../../topics/fixtures/closed-fixture.ts";
import { ask } from "../../topics/fixtures/closed-run.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
  f.seedTopic("Shard compaction keeps monthly shard files small");
  f.signal("Shard compaction thresholds were tuned today");
});

afterEach(() => {
  f.cleanup();
});

function groups(uses: string | null) {
  const status = queueStatusAt(f.m.root("dev-a"), { now: f.still() });
  return waitingByOperation(status, {
    configPath: f.configPath,
    env: uses === null ? {} : f.env(uses),
    now: f.still(),
  });
}

function route(fail?: "timeout") {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("route_") ? "T0" : undefined),
    probability: 0.9,
    ...(fail !== undefined ? { fail } : {}),
  });
}

describe("the reasons a closed question waits", () => {
  test("no decision model in force: no-model, with the setting that changes it", async () => {
    await ask(f, "topic_route:off", route());
    const [group] = groups(null);
    expect(group).toMatchObject({ operation: "topic-route", use: "topic_route", count: 1 });
    expect(group!.reasons).toEqual({ "no-model": 1 });
    expect(groups("topic_route:off")[0]!.reasons).toEqual({ "no-model": 1 });
    const status = queueStatusAt(f.m.root("dev-a"), { now: f.still() });
    const text = describeQueueStatus(status, groups(null)).join("\n");
    expect(text).toContain("1 topic-route item(s) wait");
    expect(text).toContain("`topic_route:enforce`");
  });

  test("a use in shadow, asked for the item's input: shadow", async () => {
    await ask(f, "topic_route:shadow", route());
    expect(groups("topic_route:shadow")[0]!.reasons).toEqual({ shadow: 1 });
  });

  test("private evidence and a hosted chain: needs-local-executor", async () => {
    f.signal("Shard compaction thresholds were tuned again", { partition: "private" });
    await ask(f, "topic_route:shadow", route());
    const reasons = groups("topic_route:shadow")[0]!.reasons;
    expect(reasons["needs-local-executor"]).toBe(1);
  });

  test("a failed attempt: retry-at", async () => {
    f.tune("topic_route", { route_min: 0.6 });
    await ask(f, "topic_route:enforce", route("timeout"));
    expect(groups("topic_route:enforce")[0]!.reasons).toEqual({ "retry-at": 1 });
  });

  test("a daily cost gate release names its own reason and setting", async () => {
    await ask(f, "topic_route:off", route());
    const lease = takeWork(f.queue, { run: "cost-gate-status" }).item!;
    releaseWork(f.queue, {
      item: lease.id,
      generation: lease.generation,
      lease_token: lease.lease_token,
      reason: RELEASE_COST_GATE,
    });
    const waiting = groups("topic_route:enforce")[0]!;
    expect(waiting.reasons).toEqual({ "cost-gate": 1 });
    expect(
      describeQueueStatus(queueStatusAt(f.m.root("dev-a"), { now: f.still() }), [waiting]).join(
        "\n",
      ),
    ).toContain("decision_model_cost_gate_usd");
  });

  test("ready and answerable, not taken: not-reached", async () => {
    await ask(f, "topic_route:off", route());
    expect(groups("topic_route:enforce")[0]!.reasons).toEqual({ "not-reached": 1 });
  });
});

describe("doctor", () => {
  test("routing items wait and the routing use is off: the count and the setting are named", async () => {
    await ask(f, "topic_route:off", route());
    const out: DoctorFindings = { issues: [], uncertain: [] };
    dreamQueueCheck.run(
      {
        vault: null,
        configPath: f.configPath,
        now: new Date(f.still()),
        dbPath: "",
        readable: true,
        reach: "local",
        withholdsPrivate: false,
      } as never,
      out,
    );
    const noExecutor = out.uncertain.filter((u) => u.code === "dream-queue-no-executor");
    expect(noExecutor).toHaveLength(1);
    expect(noExecutor[0]!.message).toContain("1 topic-route item(s) wait");
    expect(noExecutor[0]!.message).toContain("`topic_route:enforce`");
    const waiting = out.uncertain.filter((u) => u.code === "dream-questions-waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.message).toContain("1 no-model");
  });
});

/** The queue facts a pass would record, under the decision model `uses`. */
function facts(uses: string, extra: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, f.env(uses), extra);
  try {
    return readQueueFacts(null, f.configPath, f.still()).facts!;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe("what keeps the day of a pass open (change `dream-session-trigger`)", () => {
  test("an item a use in shadow was asked about is not answerable here", async () => {
    await ask(f, "topic_route:shadow", route());
    const queue = facts("topic_route:shadow");
    expect(queue.answerable).toEqual({});
    expect(queue.unanswerable).toEqual({ "topic-route": 1 });
    expect(dayCompletion(null, queue).complete).toBe(true);
  });

  test("private evidence the chain may not receive is not answerable here", async () => {
    f.signal("Shard compaction thresholds were tuned again", { partition: "private" });
    await ask(f, "topic_route:shadow", route());
    const queue = facts("topic_route:enforce");
    expect(queue.answerable["topic-route"]).toBeUndefined();
    expect(queue.unanswerable["topic-route"]).toBeGreaterThan(0);
  });

  test("private work the verified agent may not take is not answerable here", async () => {
    f.signal("Shard compaction thresholds were tuned again", { partition: "private" });
    await ask(f, "topic_route:off", route());
    const agent = {
      XDG_STATE_HOME: join(f.vault, "..", "agent-state"),
      OPEN_SECOND_BRAIN_DREAM_AGENT_COMMAND: JSON.stringify(["fake-agent"]),
    };
    const saved = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = agent.XDG_STATE_HOME;
    try {
      const { command } = resolveDreamAgentConfig({ config: {}, env: agent });
      recordDreamAgentVerification(command!, { agent: "custom", model: "m", programVersion: null });
    } finally {
      if (saved === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = saved;
    }
    const allowed = facts("topic_route:off", agent);
    expect(allowed.answerable["topic-route"]).toBeGreaterThan(0);
    const refused = facts("topic_route:off", {
      ...agent,
      OPEN_SECOND_BRAIN_DREAM_AGENT_PRIVATE: "off",
    });
    const privateItems = f.items("topic-route").filter((i) => i.partition === "private").length;
    expect(privateItems).toBeGreaterThan(0);
    expect(refused.unanswerable).toEqual({ "topic-route": privateItems });
  });

  test("an item not reached under an enforcing use keeps the day open", async () => {
    await ask(f, "topic_route:off", route());
    const queue = facts("topic_route:enforce");
    expect(queue.answerable).toEqual({ "topic-route": 1 });
    expect(dayCompletion(null, queue).complete).toBe(false);
  });
});
