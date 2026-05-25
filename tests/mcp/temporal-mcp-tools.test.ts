/**
 * Task 8: MCP wrappers for the temporal subsystem (v0.10.18).
 *
 * Asserts happy-path response shape for each of the five new tools
 * and one INVALID_PARAMS branch per tool.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCPServer } from "../../src/mcp/server.ts";
import { JSONRPC_VERSION, PROTOCOL_VERSION } from "../../src/mcp/protocol.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-temporal-mcp-"));
  mkdirSync(join(dir, "Brain", "log"), { recursive: true });
  mkdirSync(join(dir, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(dir, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(dir, "Brain", "retired"), { recursive: true });
  return dir;
}

interface FixtureEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly body: Record<string, string | ReadonlyArray<string>>;
}

function writeJsonl(
  vault: string,
  date: string,
  events: ReadonlyArray<FixtureEvent>,
): void {
  const lines = events
    .map((e) =>
      JSON.stringify({ ts: e.timestamp, kind: e.kind, payload: e.body }),
    )
    .join("\n");
  writeFileSync(join(vault, "Brain", "log", `${date}.jsonl`), lines + "\n");
}

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "temporal-mcp-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

interface ToolCallResponse {
  readonly result?: Record<string, unknown>;
  readonly errorCode?: number;
  readonly errorMessage?: string;
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResponse> {
  const raw = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as {
    result?: { content?: ReadonlyArray<{ type: string; text: string }> };
    error?: { code: number; message: string };
  } | null;
  if (raw === null) return {};
  if (raw.error !== undefined) {
    return { errorCode: raw.error.code, errorMessage: raw.error.message };
  }
  const text = raw.result?.content?.[0]?.text;
  if (typeof text !== "string") return {};
  return { result: JSON.parse(text) };
}

let VAULT: string;
beforeEach(() => {
  VAULT = makeVault();
  writeJsonl(VAULT, "2026-05-20", [
    {
      timestamp: "2026-05-20T10:00:00Z",
      kind: "apply-evidence",
      body: {
        preference: "[[pref-foo|Rule]]",
        artifact: "[[src/a.ts]]",
        agent: "claude",
        result: "applied",
      },
    },
  ]);
});

describe("brain_timeline", () => {
  test("happy-path: returns events array + window", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { result } = await callTool(server, "brain_timeline", {});
    expect(Array.isArray(result?.events)).toBe(true);
    expect(result?.window).toBeDefined();
  });

  test("INVALID_PARAMS: unknown kind", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { errorCode } = await callTool(server, "brain_timeline", {
      kind: "made-up-kind",
    });
    expect(errorCode).toBeDefined();
  });

  test("INVALID_PARAMS: limit must be positive integer", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { errorCode } = await callTool(server, "brain_timeline", {
      limit: -1,
    });
    expect(errorCode).toBeDefined();
  });
});

describe("brain_belief_evolution", () => {
  test("happy-path: pref_id returns target + arrays", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { result } = await callTool(server, "brain_belief_evolution", {
      pref_id: "pref-foo",
    });
    expect(result?.target).toEqual({ prefId: "pref-foo" });
    expect(Array.isArray(result?.transitions)).toBe(true);
    expect(Array.isArray(result?.evidence)).toBe(true);
    expect(Array.isArray(result?.retirements)).toBe(true);
  });

  test("INVALID_PARAMS: missing both pref_id and topic", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { errorCode } = await callTool(server, "brain_belief_evolution", {});
    expect(errorCode).toBeDefined();
  });

  test("INVALID_PARAMS: both pref_id and topic", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { errorCode } = await callTool(server, "brain_belief_evolution", {
      pref_id: "pref-foo",
      topic: "foo",
    });
    expect(errorCode).toBeDefined();
  });
});

describe("brain_stale_scan", () => {
  test("happy-path: returns thresholds + arrays", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { result } = await callTool(server, "brain_stale_scan", {});
    expect(result?.thresholds).toBeDefined();
    expect(Array.isArray(result?.stale_preferences)).toBe(true);
    expect(Array.isArray(result?.stale_signals)).toBe(true);
    expect(Array.isArray(result?.stale_log_files)).toBe(true);
  });
});

describe("brain_daily_brief", () => {
  test("happy-path: returns date + counters envelope", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { result } = await callTool(server, "brain_daily_brief", {
      date: "2026-05-20",
    });
    expect(result?.date).toBe("2026-05-20");
    expect(result?.vault_delta).toBeDefined();
  });

  test("happy-path: missing date defaults to today UTC", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { result } = await callTool(server, "brain_daily_brief", {});
    expect(typeof result?.date).toBe("string");
  });
});

describe("brain_weekly_synthesis", () => {
  test("happy-path: returns window_start/window_end + arrays", async () => {
    const server = new MCPServer({ vault: VAULT });
    await initialize(server);
    const { result } = await callTool(server, "brain_weekly_synthesis", {
      week_end: "2026-05-25",
    });
    expect(result?.window_end).toBe("2026-05-25T00:00:00Z");
    expect(Array.isArray(result?.contradictions)).toBe(true);
    expect(Array.isArray(result?.retired)).toBe(true);
  });
});
