/**
 * The launched agent on the doctor and the dream status (change
 * `dream-launched-agent`, design D8; spec "The launch command is a
 * machine setting with fallbacks": "No command"; task 6.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dreamQueueCheck } from "../../../../src/core/brain/doctor/dream-queue-check.ts";
import type { DoctorFindings } from "../../../../src/core/brain/doctor/check.ts";
import { recordDreamAgentLastRun } from "../../../../src/core/brain/dream-queue/agent-verified.ts";
import { answerWork, takeWork } from "../../../../src/core/brain/dream-queue/queue.ts";
import {
  describeDreamAgent,
  dreamAgentStatus,
  queueStatus,
} from "../../../../src/core/brain/dream-queue/status-view.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { SETTING_SET_KIND } from "../../../../src/core/store/constants.ts";
import { agentFixture, AGENT_TEXT, type AgentFixture } from "./fixture.ts";

let x: AgentFixture;
const KEY = "OPEN_SECOND_BRAIN_DREAM_AGENT_COMMAND";
let before: string | undefined;

beforeEach(() => {
  x = agentFixture();
  before = process.env[KEY];
});

afterEach(() => {
  if (before === undefined) delete process.env[KEY];
  else process.env[KEY] = before;
  x.cleanup();
});

function doctor(): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  dreamQueueCheck.run(
    {
      vault: null,
      configPath: x.f.configPath,
      now: new Date(),
      dbPath: "",
      readable: true,
      reach: "local",
      withholdsPrivate: false,
    } as never,
    out,
  );
  return out;
}

function codes(out: DoctorFindings): string[] {
  return [...out.issues.map((i) => i.code), ...out.uncertain.map((u) => u.code)].toSorted();
}

function setCommand(mode: string): void {
  const command = x.command(mode);
  process.env[KEY] = JSON.stringify([command.program, ...command.args]);
}

describe("doctor", () => {
  test("text work waits and no agent is set: dream-agent-unset, and the no-executor line names the agent", () => {
    x.text("a");
    const out = doctor();
    expect(codes(out)).toEqual(["dream-agent-unset", "dream-queue-no-executor"]);
    const unset = out.uncertain.find((u) => u.code === "dream-agent-unset")!;
    expect(unset.message).toContain("o2b dream agent set");
    const noExecutor = out.uncertain.find((u) => u.code === "dream-queue-no-executor")!;
    expect(noExecutor.message).toContain("only the dream agent answers them");
  });

  test("nothing waits: no agent code", () => {
    expect(codes(doctor())).toEqual([]);
  });

  test("a command never verified: dream-agent-unverified; verified: quiet", () => {
    x.text("a");
    setCommand("answer-all");
    expect(codes(doctor())).toContain("dream-agent-unverified");
    x.verify(x.command("answer-all"));
    const out = doctor();
    expect(codes(out)).not.toContain("dream-agent-unverified");
    expect(codes(out)).not.toContain("dream-queue-no-executor");
  });

  test("the last run failed: dream-agent-failed says how", () => {
    recordDreamAgentLastRun({
      at: "2026-11-22T10:00:00.000Z",
      status: "ran",
      agent: "custom",
      model: null,
      answered: 0,
      ended: "timed-out",
      failed: true,
    });
    const failed = doctor().issues.find((i) => i.code === "dream-agent-failed");
    expect(failed?.message).toContain("timed-out");
  });

  test("text answers await review: dream-drafts-waiting with the count", () => {
    appendRecord(x.f.a, {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "o2b",
      body: { authority: "human", key: "dream.apply_drafts", value: "review" },
    });
    const id = x.text("a");
    const taken = takeWork(x.f.queue, { run: "t" });
    answerWork(x.f.queue, {
      item: id,
      generation: taken.item!.generation,
      lease_token: taken.item!.lease_token,
      text: "---\nkind: rollup\n---\nBody.\n",
      agent: "claude",
      model: "m",
    });
    const drafts = doctor().uncertain.find((u) => u.code === "dream-drafts-waiting");
    expect(drafts?.message).toContain("1 text answer(s)");
  });
});

describe("the dream status", () => {
  test("the command, verified or not and when, the last run; the executor per operation", () => {
    x.text("a");
    expect(dreamAgentStatus(x.f.configPath).command).toBeNull();
    let status = queueStatus(null, { configPath: x.f.configPath });
    expect(status.available && status.executor).toEqual({ [AGENT_TEXT]: false });
    setCommand("answer-all");
    expect(describeDreamAgent(dreamAgentStatus(x.f.configPath))[0]).toContain("not verified");
    x.verify(x.command("answer-all"));
    const agent = dreamAgentStatus(x.f.configPath);
    expect(agent.command).toBe("custom");
    expect(agent.verified_at).not.toBeNull();
    status = queueStatus(null, { configPath: x.f.configPath });
    expect(status.available && status.executor).toEqual({ [AGENT_TEXT]: true });
    recordDreamAgentLastRun({
      at: "2026-11-22T10:00:00.000Z",
      status: "no-time",
      agent: null,
      model: null,
      answered: 0,
      ended: null,
      failed: false,
    });
    expect(describeDreamAgent(dreamAgentStatus(x.f.configPath))[1]).toContain("no-time");
  });
});
