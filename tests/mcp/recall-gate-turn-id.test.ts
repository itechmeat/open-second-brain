/**
 * `brain_recall_gate` accepts the `turn_id` correlation argument its
 * sibling `brain_context_pack` already declares, and records it on the
 * `gate_telemetry` record when telemetry is on. The Hermes provider sends
 * it on every prefetch; before the gate declared it, the closed input
 * schema refused the whole call.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTINUITY_TURN_ID_KEY } from "../../src/core/brain/continuity/types.ts";
import { listGateTelemetry } from "../../src/core/brain/gate-telemetry.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

/** The declared bound, shared with `session_id` and the context pack's `turn_id`. */
const TURN_ID_MAX_CHARS = 512;
const TURN_ID = "turn-7";
const PROMPT = "what did we decide about the index?";

let tmp: string;
let vault: string;
let configPath: string;
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-gate-turn-id-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function server(telemetry: boolean): MCPServer {
  writeFileSync(
    configPath,
    `vault: ${JSON.stringify(vault)}\n${telemetry ? 'recall_gate_telemetry: "true"\n' : ""}`,
  );
  return new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
}

test("the gate accepts turn_id and records it on the gate telemetry record", async () => {
  const result = await server(true).callTool("brain_recall_gate", {
    prompt: PROMPT,
    session_id: "sess-1",
    turn_id: TURN_ID,
  });
  expect(result.isError).toBe(false);
  const records = listGateTelemetry(vault);
  expect(records).toHaveLength(1);
  expect(records[0]!.payload[CONTINUITY_TURN_ID_KEY]).toBe(TURN_ID);
  expect(records[0]!.payload["session_id"]).toBe("sess-1");
});

test("a call without turn_id records no turn_id key", async () => {
  await server(true).callTool("brain_recall_gate", { prompt: PROMPT });
  const records = listGateTelemetry(vault);
  expect(records).toHaveLength(1);
  expect(CONTINUITY_TURN_ID_KEY in records[0]!.payload).toBe(false);
});

test("with telemetry off the gate accepts turn_id and writes nothing", async () => {
  const result = await server(false).callTool("brain_recall_gate", {
    prompt: PROMPT,
    turn_id: TURN_ID,
  });
  expect(result.isError).toBe(false);
  expect(listGateTelemetry(vault)).toHaveLength(0);
});

test("a turn_id over the declared bound is refused", async () => {
  const call = server(true).callTool("brain_recall_gate", {
    prompt: PROMPT,
    turn_id: "t".repeat(TURN_ID_MAX_CHARS + 1),
  });
  // The bound's own message: a closed schema that does not declare turn_id
  // also names the argument ("unknown argument 'turn_id'"), so a bare
  // /turn_id/ passes even where the argument was never accepted.
  await expect(call).rejects.toThrow(`argument 'turn_id' exceeds ${TURN_ID_MAX_CHARS} characters`);
  expect(listGateTelemetry(vault)).toHaveLength(0);
});

test("a turn_id at the declared bound is accepted", async () => {
  const result = await server(true).callTool("brain_recall_gate", {
    prompt: PROMPT,
    turn_id: "t".repeat(TURN_ID_MAX_CHARS),
  });
  expect(result.isError).toBe(false);
});

test("a session_id over the declared bound is refused even with telemetry off", async () => {
  const call = server(false).callTool("brain_recall_gate", {
    prompt: PROMPT,
    session_id: "s".repeat(TURN_ID_MAX_CHARS + 1),
  });
  await expect(call).rejects.toThrow(
    `argument 'session_id' exceeds ${TURN_ID_MAX_CHARS} characters`,
  );
});
