/**
 * A staged pass waits for the replay (dream replay task 5.4; spec "A
 * staged pass waits for the replay"): stage, validate, apply and retriage
 * are refused while windows are behind, through the core, the verb and
 * the MCP tool, and work as before with coverage at yesterday.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DreamReplayBehindError } from "../../../../src/core/brain/dream-replay/behind.ts";
import {
  applyDreamBundle,
  retriageDreamBundle,
  stageDream,
  validateDreamBundle,
} from "../../../../src/core/brain/dream-stage.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { TRANSPORT_REACH } from "../../../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../../src/mcp/index.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, dateOf } from "../../../helpers/dream-replay-scenarios.ts";
import { runCli } from "../../../helpers/run-cli.ts";

let fx: DreamReplayFixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

const NOW = new Date(`${dateOf(3)}T12:00:00Z`);

function cluster(f: DreamReplayFixture, day: number): void {
  for (const [slug, agent] of [
    ["c1", "claude"],
    ["c2", "codex"],
    ["c3", "hermes"],
  ] as const) {
    writeSignal(f.vault, {
      topic: "staged",
      signal: "positive",
      agent,
      principle: "Follow the staged rule.",
      created_at: at(day, 9),
      date: dateOf(day),
      slug,
      scope: "coding",
    });
  }
}

describe("dream replay: the staged flow", () => {
  test("every staged action is refused while windows are behind, and writes nothing", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    cluster(fx, 3);
    const before = fx.replayRecords().length;
    const opts = { now: NOW };
    for (const action of [
      () => stageDream(fx!.vault, opts),
      () => validateDreamBundle(fx!.vault, "stage-2026-04-04-120000", opts),
      () => applyDreamBundle(fx!.vault, "stage-2026-04-04-120000", opts),
      () => retriageDreamBundle(fx!.vault, "stage-2026-04-04-120000", opts),
    ]) {
      let refused: unknown = null;
      try {
        action();
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(DreamReplayBehindError);
      expect((refused as DreamReplayBehindError).days).toEqual([dateOf(1), dateOf(2)]);
      expect((refused as Error).message).toContain("o2b brain dream");
    }
    expect(fx.replayRecords()).toHaveLength(before);
    expect(existsSync(join(fx.vault, "Brain", "dream", "staged"))).toBe(false);
  });

  test("the verb refuses with the code, the windows and the command", async () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    const out = await runCli([
      "brain",
      "dream",
      "stage",
      "--now",
      NOW.toISOString(),
      "--vault",
      fx.vault,
      "--json",
    ]);
    expect(out.returncode).toBe(1);
    const body = JSON.parse(out.stdout) as { code: string; days: string[] };
    expect(body.code).toBe("dream_replay_behind");
    expect(body.days).toEqual([dateOf(1), dateOf(2)]);
  });

  test("the MCP tool refuses with the code", async () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(0));
    const server = new MCPServer(
      { vault: fx.vault, configPath: fx.configPath },
      { reach: TRANSPORT_REACH.local },
    );
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "dream-replay-staged", version: "0" },
      },
    });
    await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
    const reply = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: { name: "brain_dream", arguments: { action: "stage", now: NOW.toISOString() } },
    })) as { result?: { isError?: boolean; _meta?: Record<string, { code?: string }> } };
    expect(reply.result?.isError).toBe(true);
    expect(JSON.stringify(reply.result)).toContain("dream_replay_behind");
  });

  test("with coverage at yesterday the staged flow works as before and applies today's window", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(2));
    cluster(fx, 3);
    const bundle = stageDream(fx.vault, { now: NOW });
    expect(validateDreamBundle(fx.vault, bundle.runId, { now: NOW }).valid).toBe(true);
    const outcome = applyDreamBundle(fx.vault, bundle.runId, { now: NOW });
    expect(outcome.applied).toBe(true);
    const admitted = fx
      .replayRecords()
      .filter((r) => r.kind === "dream-admission")
      .map((r) => r.body["day"]);
    expect(admitted).toEqual([dateOf(3)]);
  });

  test("every staged action is refused while today's window is open", () => {
    fx = makeDreamReplayFixture();
    fx.cover(dateOf(2));
    const today = dateOf(3);
    // A pass stopped inside today's window: admitted, not covered.
    fx.append("dream-admission", {
      day: today,
      window: today,
      from: `${today}T00:00:00.000Z`,
      to: `${today}T23:59:59.999Z`,
      positions: [],
      gaps: [],
      late: [],
      clamped: [],
      left_out: [],
      rebased: null,
      admitted_at: `${today}T10:00:00.000Z`,
      run: "fixture",
    });
    expect(fx.replayState().open?.body.day).toBe(today);
    const opts = { now: NOW };
    for (const action of [
      () => stageDream(fx!.vault, opts),
      () => validateDreamBundle(fx!.vault, "stage-2026-04-04-120000", opts),
      () => applyDreamBundle(fx!.vault, "stage-2026-04-04-120000", opts),
      () => retriageDreamBundle(fx!.vault, "stage-2026-04-04-120000", opts),
    ]) {
      expect(action).toThrow(DreamReplayBehindError);
      expect(action).toThrow(`the window of ${today} is open`);
    }
  });
});
