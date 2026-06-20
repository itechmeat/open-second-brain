/**
 * MCP integration tests for `brain_memory_bridge` (t_5e06b572): the hidden
 * host-bridge tool that persists a Hermes built-in memory write into the
 * vault as a durable host_memory_write continuity record. Drives the full
 * server path so registration, the hidden-from-tools/list contract, and the
 * output shape are all covered here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { continuityLogPath, listContinuityRecords } from "../../src/core/brain/continuity/store.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-membridge-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-membridge-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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
      clientInfo: { name: "membridge-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function listToolNames(server: MCPServer): Promise<string[]> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/list",
    params: {},
  })) as { result?: { tools: ReadonlyArray<{ name: string }> } };
  return (r.result?.tools ?? []).map((t) => t.name);
}

async function callBridge(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: { message: string; data?: unknown } }> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_memory_bridge", arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }>; isError?: boolean };
    error?: { message: string; data?: unknown };
  };
  if (r.error) return { error: r.error };
  const text = r.result!.content[0]!.text;
  if (r.result!.isError) return { error: { message: text } };
  return { result: JSON.parse(text) };
}

describe("brain_memory_bridge — registration", () => {
  test("is advertised (not hidden) and callable", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    // Advertised normally — hidden tools are banned by the 1.0.0 sweep. The
    // Hermes agent still never sees it: the provider's MEMORY_TOOLS allowlist
    // (tested on the Python side) excludes it; only the on_memory_write hook
    // calls it via the bridge.
    expect(await listToolNames(server)).toContain("brain_memory_bridge");
    const { result } = await callBridge(server, {
      action: "add",
      target: "user",
      content: "callable",
    });
    expect(result?.["recorded"]).toBe(true);
  });
});

describe("brain_memory_bridge — persistence", () => {
  test("a single host write lands as a host_memory_write continuity record", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const { result } = await callBridge(server, {
      action: "add",
      target: "user",
      content: "User prefers dark mode",
      metadata: { write_origin: "tool", session_id: "sess-1" },
    });
    expect(result?.["recorded"]).toBe(true);
    expect(result?.["kind"]).toBe("host_memory_write");
    expect(result?.["count"]).toBe(1);

    const records = listContinuityRecords(vault, { kind: "host_memory_write" });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["content"]).toBe("User prefers dark mode");
    expect(records[0]!.payload["target"]).toBe("user");
  });

  test("an operations batch is applied atomically through the shared substrate", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const { result } = await callBridge(server, {
      operations: [
        { action: "add", target: "user", content: "one" },
        { action: "replace", target: "memory", content: "two" },
      ],
    });
    expect(result?.["count"]).toBe(2);
    expect(listContinuityRecords(vault, { kind: "host_memory_write" })).toHaveLength(2);
  });
});

describe("brain_memory_bridge — explicit rejection, no write", () => {
  test("a non-bridged action returns a structured INVALID_PARAMS and writes nothing", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const { result, error } = await callBridge(server, {
      action: "remove",
      target: "user",
      content: "x",
    });
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect(error!.message).toContain("brain_memory_bridge");
    expect((error!.data as Record<string, unknown>)["code"]).toBe("invalid_action");
    expect(listContinuityRecords(vault, { kind: "host_memory_write" })).toHaveLength(0);
  });

  test("a malformed entry in a batch aborts the whole batch with no write", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const { error } = await callBridge(server, {
      operations: [
        { action: "add", target: "user", content: "good" },
        { action: "add", target: "nowhere", content: "bad" },
      ],
    });
    expect(error).toBeDefined();
    expect((error!.data as Record<string, unknown>)["code"]).toBe("invalid_target");
    expect(existsSync(continuityLogPath(vault, new Date().toISOString().slice(0, 7)))).toBe(false);
    expect(listContinuityRecords(vault, { kind: "host_memory_write" })).toHaveLength(0);
  });
});
