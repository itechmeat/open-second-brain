/**
 * The verification of a dream agent command (change
 * `dream-launched-agent`, design D5; spec "The command is verified by a
 * real call"; task 4.1). The session is the fake agent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";

import { checkDreamAgent } from "../../../../src/core/brain/dream-queue/agent-check.ts";
import { runAgentExecutor } from "../../../../src/core/brain/dream-queue/agent-executor.ts";
import {
  dreamAgentStateDir,
  dreamAgentVerification,
} from "../../../../src/core/brain/dream-queue/agent-verified.ts";
import { readStreamRecords } from "../../../../src/core/store/read/stream-read.ts";
import { storesStateDir } from "../../../../src/core/store/store-paths.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { agentFixture, type AgentFixture } from "./fixture.ts";

let x: AgentFixture;

beforeEach(() => {
  x = agentFixture();
});

afterEach(() => {
  x.cleanup();
});

function brainRecords(): number {
  return ["shared", "private"].reduce(
    (n, p) =>
      n + readStreamRecords(x.f.a.root, p as "shared", { stream: "dream-work" }).records.length,
    0,
  );
}

function storeStates(): string[] {
  return existsSync(storesStateDir()) ? readdirSync(storesStateDir()) : [];
}

describe("checkDreamAgent", () => {
  test("passes when both canaries are answered and finish is called; recorded and used by the worker", async () => {
    const command = x.command("check");
    const before = brainRecords();
    const states = storeStates();
    const result = await checkDreamAgent(command, { configPath: x.f.configPath });
    expect(result).toMatchObject({ ok: true, agent: "custom", model: "fake-model-1" });
    expect(dreamAgentVerification(command)).toMatchObject({
      agent: "custom",
      model: "fake-model-1",
    });
    // The throwaway store is gone, and nothing reached the brain's store.
    expect(readdirSync(dreamAgentStateDir()).filter((n) => n.startsWith("check-"))).toEqual([]);
    expect(storeStates()).toEqual(states);
    expect(brainRecords()).toBe(before);
    // The worker uses the verified command; a changed one is unverified again.
    x.text("a");
    const ran = await runAgentExecutor(x.f.queue, x.owner(), {
      configPath: x.f.configPath,
      env: x.env(command, { OPEN_SECOND_BRAIN_DREAM_AGENT_BUDGET_MS: "30000" }),
    });
    expect(ran.status).toBe("ran");
    x.text("b");
    const changed = x.command("check-changed");
    expect(dreamAgentVerification(changed)).toBeNull();
    const refused = await runAgentExecutor(x.f.queue, x.owner(), {
      configPath: x.f.configPath,
      env: x.env(changed),
    });
    expect(refused).toEqual({ status: "skipped", reason: "unverified" });
  }, 60_000);

  for (const [mode, reason, seen] of [
    ["no-tools", "the session never called the tools", "it never listed the tools"],
    ["wrong", "the session answered a canary wrongly", "dream_work_answer failed x2"],
    ["no-finish", "the session did not call finish", "dream_work_take item x2"],
  ] as const) {
    test(`fails when the session is ${mode}, says what it saw, and stays unverified`, async () => {
      const command = x.command(mode);
      const result = await checkDreamAgent(command, { configPath: x.f.configPath });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(reason);
      expect(result.seen).toContain(seen);
      expect(dreamAgentVerification(command)).toBeNull();
    }, 60_000);
  }

  test("does not verify a session that answers and finishes before exiting unsuccessfully", async () => {
    const command = x.command("fail-after-finish");
    const env = Object.fromEntries(
      Object.entries(x.env(command)).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const result = await runCli(["dream", "agent", "check"], { env });
    expect(result.returncode).toBe(1);
    expect(result.stdout).toContain("the session did not end successfully");
    expect(result.stdout).toContain("exited 1");
    expect(dreamAgentVerification(command)).toBeNull();
  }, 60_000);

  test("a session that never takes a canary fails within the limit", async () => {
    const started = Date.now();
    const result = await checkDreamAgent(x.command("hang-before"), {
      configPath: x.f.configPath,
      limitMs: 3_000,
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.ok).toBe(false);
  }, 60_000);
});

describe("o2b dream agent", () => {
  test("check prints what the call log shows on failure; set and show round-trip", async () => {
    const command = x.command("no-tools");
    const json = JSON.stringify([command.program, ...command.args]);
    const failed = await runCli(
      ["dream", "agent", "check", "--command", json, "--config", x.f.configPath],
      { env: { O2B_DEVICE_ID: "dev-a", XDG_STATE_HOME: process.env["XDG_STATE_HOME"]! } },
    );
    expect(failed.returncode).toBe(1);
    expect(failed.stdout).toContain("failed: the session never called the tools");
    expect(failed.stdout).toContain("it never listed the tools");
    const set = await runCli(["dream", "agent", "set", json, "--config", x.f.configPath], {
      env: { XDG_STATE_HOME: process.env["XDG_STATE_HOME"]! },
    });
    expect(set.returncode).toBe(0);
    const shown = await runCli(["dream", "agent", "show", "--json", "--config", x.f.configPath], {
      env: { XDG_STATE_HOME: process.env["XDG_STATE_HOME"]! },
    });
    expect(JSON.parse(shown.stdout)).toMatchObject({
      command: { label: "custom", program: command.program, args: command.args },
      verified: null,
    });
  }, 60_000);
});
