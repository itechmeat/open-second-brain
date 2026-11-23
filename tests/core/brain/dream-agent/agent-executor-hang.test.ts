/**
 * A dream session that hangs is ended at the deadline (change
 * `dream-launched-agent`, design D4; spec "A run is bounded": "A session
 * that hangs"; task 3.1). Its own file: the run waits out the smallest
 * budget a session may have (30 seconds).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  DREAM_AGENT_MIN_MS,
  runAgentExecutor,
} from "../../../../src/core/brain/dream-queue/agent-executor.ts";
import { agentFixture, AGENT_TEXT, type AgentFixture } from "./fixture.ts";

let x: AgentFixture;

beforeEach(() => {
  x = agentFixture();
});

afterEach(() => {
  x.cleanup();
});

test("a session that hangs is ended at the deadline, its lease released, and the pass completes", async () => {
  x.text("a");
  const command = x.command("hang");
  x.verify(command);
  const started = Date.now();
  const result = await runAgentExecutor(x.f.queue, x.owner(), {
    configPath: x.f.configPath,
    env: x.env(command, { OPEN_SECOND_BRAIN_DREAM_AGENT_BUDGET_MS: String(DREAM_AGENT_MIN_MS) }),
  });
  expect(Date.now() - started).toBeLessThan(DREAM_AGENT_MIN_MS + 15_000);
  expect(result.status === "ran" && result.runs[0]!.ended).toBe("timed-out");
  expect(x.f.items(AGENT_TEXT).map((i) => i.state)).toEqual(["waiting"]);
}, 90_000);
