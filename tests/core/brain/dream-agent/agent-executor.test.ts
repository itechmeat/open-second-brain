/**
 * The launched agent as an executor (change `dream-launched-agent`,
 * design D4; spec "The launch command is a machine setting with
 * fallbacks", "A run is bounded", "The session works only through three
 * operations", "The agent answers closed questions nobody else answers";
 * task 3.1). Every session is the fake agent (`fake-dream-agent.ts`)
 * talking to a real `o2b mcp --tool-profile dream-executor` server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  agentOperations,
  runAgentExecutor,
} from "../../../../src/core/brain/dream-queue/agent-executor.ts";
import { readDreamAgentLastRun } from "../../../../src/core/brain/dream-queue/agent-verified.ts";
import { dreamRunsDir } from "../../../../src/core/brain/dream-queue/run-record.ts";
import { CLOSED_OPERATIONS } from "../../../../src/core/topics/decide-operations.ts";
import { prepareClosedQuestions } from "../../../../src/core/topics/decide-auto.ts";
import { readTopicQuestionState } from "../../../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../../../src/core/topics/decide-produce.ts";
import { TOPIC_ASSIGN_KIND } from "../../../../src/core/topics/constants.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import { join } from "node:path";
import { plan } from "../../topics/fixtures/closed-run.ts";
import { existsSync, readdirSync } from "node:fs";
import { agentFixture, AGENT_TEXT, type AgentFixture } from "./fixture.ts";

let x: AgentFixture;

beforeEach(() => {
  x = agentFixture();
});

afterEach(() => {
  x.cleanup();
});

function run(
  mode: string,
  extra: Record<string, string> = {},
  options: Record<string, unknown> = {},
) {
  const command = x.command(mode);
  x.verify(command);
  return runAgentExecutor(x.f.queue, x.owner(), {
    configPath: x.f.configPath,
    env: x.env(command, { OPEN_SECOND_BRAIN_DREAM_AGENT_BUDGET_MS: "30000", ...extra }),
    ...options,
  });
}

function states(): string[] {
  return x.f.items(AGENT_TEXT).map((i) => i.state);
}

function leftovers(): string[] {
  const dir = dreamRunsDir(x.f.a.deviceStateDir);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n !== "last-session.log") : [];
}

describe("runAgentExecutor", () => {
  test("a session that answers everything: accepted with the run's agent and the stated model", async () => {
    x.text("a");
    x.text("b");
    const result = await run("answer-all");
    expect(result).toMatchObject({ status: "ran", answered: 2 });
    for (const item of x.f.items(AGENT_TEXT)) {
      expect(item.state).toBe("accepted");
      expect(item.answer).toMatchObject({ agent: "custom", model: "fake-model-1" });
    }
    expect(leftovers()).toEqual([]);
    expect(readDreamAgentLastRun()).toMatchObject({
      status: "ran",
      agent: "custom",
      model: "fake-model-1",
      answered: 2,
      failed: false,
    });
  }, 60_000);

  test("a session that stops at its item budget is followed by another while work and time last", async () => {
    for (const s of ["a", "b", "c", "d", "e"]) x.text(s);
    const result = await run("answer-all", {
      OPEN_SECOND_BRAIN_DREAM_AGENT_ITEMS: "2",
      OPEN_SECOND_BRAIN_DREAM_AGENT_BATCH: "2",
    });
    expect(result.status === "ran" && result.runs.map((r) => r.answered)).toEqual([2, 2, 1]);
    expect(result).toMatchObject({ status: "ran", answered: 5 });
    expect(states()).toEqual(["accepted", "accepted", "accepted", "accepted", "accepted"]);
    expect(leftovers()).toEqual([]);
    expect(readDreamAgentLastRun()).toMatchObject({ status: "ran", answered: 5, failed: false });
  }, 90_000);

  test("a session that exits early: its lease is released and the item is offered again", async () => {
    x.text("a");
    const result = await run("exit-early");
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    expect(result.runs[0]).toMatchObject({ ended: "exited 1", failed: true, answered: 0 });
    expect(states()).toEqual(["waiting"]);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  test("a session that never calls the tools answers nothing", async () => {
    x.text("a");
    const result = await run("no-tools");
    expect(result.status === "ran" && result.runs[0]).toMatchObject({
      ended: "exited 0",
      answered: 0,
      failed: true,
      calls: [],
    });
    expect(states()).toEqual(["waiting"]);
  }, 60_000);

  test("after a failure the fallback is tried once and the run records which answered", async () => {
    x.text("a");
    const first = x.command("fail");
    const second = x.command("answer-all");
    const third = x.command("answer-all-again");
    for (const c of [first, second, third]) x.verify(c);
    const result = await runAgentExecutor(x.f.queue, x.owner(), {
      configPath: x.f.configPath,
      env: x.env(first, { OPEN_SECOND_BRAIN_DREAM_AGENT_BUDGET_MS: "30000" }, [second, third]),
    });
    expect(result.status === "ran" && result.runs.map((r) => [r.ended, r.answered])).toEqual([
      ["exited 3", 0],
      ["exited 0", 1],
    ]);
    expect(states()).toEqual(["accepted"]);
  }, 60_000);

  test("no command, or no verified command: nothing is started", async () => {
    x.text("a");
    const none = await runAgentExecutor(x.f.queue, x.owner(), {
      configPath: x.f.configPath,
      env: { ...process.env },
    });
    expect(none).toEqual({ status: "skipped", reason: "no-command" });
    const unverified = await runAgentExecutor(x.f.queue, x.owner(), {
      configPath: x.f.configPath,
      env: x.env(x.command("answer-all")),
    });
    expect(unverified).toEqual({ status: "skipped", reason: "unverified" });
    expect(states()).toEqual(["waiting"]);
  });

  test("the budget is clamped to the caller's time less the reserve; under the minimum, no-time", async () => {
    x.text("a");
    const result = await run("answer-all", {}, { callerRemainingMs: 100_000 });
    expect(result).toEqual({ status: "skipped", reason: "no-time" });
    expect(readDreamAgentLastRun()?.status).toBe("no-time");
    expect(states()).toEqual(["waiting"]);
  });

  test("inside a dream session no session is started (no recursion)", async () => {
    x.text("a");
    const result = await run("answer-all", {
      OPEN_SECOND_BRAIN_DREAM_RUN: "0b0c3a2e-1111-4222-8333-444455556666",
    });
    expect(result).toEqual({ status: "skipped", reason: "inside-session" });
  });

  test("nothing ready for an agent: nothing is started", async () => {
    expect(await run("answer-all")).toEqual({ status: "skipped", reason: "no-work" });
  });

  test("private items are withheld when dream_agent_private is off", async () => {
    x.text("secret", ["private"]);
    const result = await run("answer-all", { OPEN_SECOND_BRAIN_DREAM_AGENT_PRIVATE: "off" });
    expect(result).toEqual({ status: "skipped", reason: "no-work" });
    x.text("open");
    const second = await run("answer-all", { OPEN_SECOND_BRAIN_DREAM_AGENT_PRIVATE: "off" });
    expect(second).toMatchObject({ status: "ran", answered: 1 });
    const byPartition = Object.fromEntries(
      x.f.items(AGENT_TEXT).map((i) => [i.partition, i.state]),
    );
    expect(byPartition).toEqual({ private: "waiting", shared: "accepted" });
  }, 60_000);
});

describe("closed questions nobody else answers", () => {
  test("with no decision model the session answers routing items and the records are routed", async () => {
    const topic = x.f.seedTopic("Shard compaction keeps monthly shard files small");
    const record = x.f.signal("Shard compaction thresholds were tuned today");
    produceTopicQuestions(x.f.queue, readTopicQuestionState(x.f.a, x.f.still())!, {
      until: Number.POSITIVE_INFINITY,
      clock: x.f.still,
    });
    const result = await run("answer-all");
    expect(result).toMatchObject({ status: "ran", answered: 1 });
    const [item] = x.f.items("topic-route");
    expect(item!.answer?.value).toMatchObject({
      choice: topic,
      confidence: 0.9,
      provider: "custom",
      model: "fake-model-1",
    });
    plan(x.f);
    const assigns = readPartition(join(x.f.m.root("dev-a"), "shared"))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === TOPIC_ASSIGN_KIND);
    expect(assigns.map((r) => [r.topic, r.body["record"]])).toEqual([[topic, record]]);
    expect(assigns[0]!.body["verdict"]).toMatchObject({
      provider: "custom",
      model: "fake-model-1",
    });
  }, 60_000);
});

describe("the front door", () => {
  // The MCP dream tool and the lane task hand the front door what is left
  // of their shared deadline (`deadlineMs`); the dream verb hands none.
  test("a caller's deadline under the reserve and the minimum starts no session", async () => {
    x.text("a");
    const command = x.command("answer-all");
    x.verify(command);
    const ran = await prepareClosedQuestions(null, {
      configPath: x.f.configPath,
      env: x.env(command),
      deadlineMs: 100_000,
    });
    expect(ran?.agent).toEqual({ status: "skipped", reason: "no-time", answered: 0 });
    expect(states()).toEqual(["waiting"]);
  });

  test("the verb's pass runs the session under the setting", async () => {
    x.text("a");
    const command = x.command("answer-all");
    x.verify(command);
    const ran = await prepareClosedQuestions(null, {
      configPath: x.f.configPath,
      env: x.env(command, { OPEN_SECOND_BRAIN_DREAM_AGENT_BUDGET_MS: "30000" }),
    });
    expect(ran?.agent).toEqual({ status: "ran", answered: 1 });
    expect(states()).toEqual(["accepted"]);
  }, 60_000);
});

describe("agentOperations", () => {
  test("text operations always; closed ones only when the decision model does not answer them", () => {
    const none = agentOperations(x.f.configPath, {});
    expect(none).toContain(AGENT_TEXT);
    expect(none).toEqual(expect.arrayContaining([...CLOSED_OPERATIONS]));
    x.f.tune("topic_route", { route_min: 0.6 });
    const some = agentOperations(x.f.configPath, x.f.env("topic_route:enforce,topic_new:off"));
    expect(some).toContain(AGENT_TEXT);
    expect(some).toContain("topic-new");
    expect(some).not.toContain("topic-route");
  });
});
