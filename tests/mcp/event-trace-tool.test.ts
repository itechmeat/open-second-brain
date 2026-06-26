import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-event-trace-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-event-trace-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "event-trace-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function callEventTrace(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_event_trace", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_event_trace tool registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((tool) => tool.name === "brain_event_trace")).toBeDefined();
  });

  test("not registered in the writer-only tool table", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((tool) => tool.name === "brain_event_trace")).toBeUndefined();
  });
});

describe("brain_event_trace tool", () => {
  test("joins continuity records to a logged event by session id", async () => {
    appendLogEvent(vault, {
      timestamp: "2026-06-15T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.writeSession,
      agent: "tester",
      body: { session_id: "sess-1", kind: "note", status: "committed" },
    });
    const want = appendContinuityRecord(vault, {
      kind: "recall_telemetry",
      createdAt: "2026-06-15T10:00:05Z",
      sourceRefs: [],
      payload: { session_id: "sess-1", mode: "context_pack", status: "ok" },
    }).id;

    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const result = await callEventTrace(server, { date: "2026-06-15" });
    expect(result["total"]).toBe(1);
    expect(result["trace_total"]).toBe(1);
    const events = result["events"] as Array<Record<string, unknown>>;
    const traces = events[0]!["traces"] as Array<Record<string, unknown>>;
    expect(traces[0]!["id"]).toBe(want);
    expect(traces[0]!["joinedBy"]).toEqual(["session"]);
  });

  test("rejects an unknown event kind", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: { name: "brain_event_trace", arguments: { kind: "not-a-kind" } },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32602);
  });

  test("a runtime IO error surfaces as INTERNAL_ERROR, not INVALID_PARAMS", async () => {
    // Brain/log exists but is a FILE: existsSync passes, readdirSync throws
    // ENOTDIR inside the resolver's IO path. A bad selector is a caller error
    // (-32602); a runtime IO failure must be an internal error (-32603).
    rmSync(join(vault, "Brain", "log"), { recursive: true, force: true });
    writeFileSync(join(vault, "Brain", "log"), "not a directory\n");
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: { name: "brain_event_trace", arguments: { date: "2026-06-15" } },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32603);
  });
});
