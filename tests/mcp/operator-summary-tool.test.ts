/**
 * MCP integration coverage for `brain_operator_summary` (v0.10.16).
 * Verifies registration in the full tool scope and the JSON-RPC
 * round-trip shape.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
} from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-op-summary-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-op-summary-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
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
      clientInfo: { name: "op-summary-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callSummary(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_operator_summary", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text);
}

describe("brain_operator_summary tool registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((t) => t.name === "brain_operator_summary")).toBeDefined();
  });

  test("NOT in the writer-only scope", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((t) => t.name === "brain_operator_summary")).toBeUndefined();
  });
});

describe("brain_operator_summary tool - round trip", () => {
  test("clean vault returns trust_verdict=clean", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callSummary(server, {});
    expect(out["trust_verdict"]).toBe("clean");
    expect(out["doctor_summary"]).toEqual({ warning_count: 0, error_count: 0 });
    const ifWarn = out["instruction_file_warnings"] as ReadonlyArray<unknown>;
    expect(Array.isArray(ifWarn)).toBe(true);
    expect(ifWarn).toEqual([]);
  });

  test("long CLAUDE.md surfaces instruction-file warning", async () => {
    writeFileSync(join(vault, "CLAUDE.md"), "x\n".repeat(300));
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callSummary(server, {});
    const ifWarn = out["instruction_file_warnings"] as Array<{ path: string; lines: number }>;
    expect(ifWarn).toHaveLength(1);
    expect(ifWarn[0]?.path).toBe("CLAUDE.md");
  });

  test("rejects negative top_actions via INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 11,
      method: "tools/call",
      params: { name: "brain_operator_summary", arguments: { top_actions: -1 } },
    })) as { error?: { code: number; message: string } };
    expect(r.error).toBeDefined();
    // JSON-RPC INVALID_PARAMS = -32602. Assert the specific code so
    // the test fails on the wrong failure mode (e.g. INTERNAL_ERROR
    // smuggled through).
    expect(r.error?.code).toBe(-32602);
  });

  test("rejects malformed top_actions string via INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 12,
      method: "tools/call",
      params: {
        name: "brain_operator_summary",
        arguments: { top_actions: "3abc" },
      },
    })) as { error?: { code: number; message: string } };
    expect(r.error?.code).toBe(-32602);
  });

  test("rejects non-boolean include_dream via INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 13,
      method: "tools/call",
      params: {
        name: "brain_operator_summary",
        arguments: { include_dream: "yes" },
      },
    })) as { error?: { code: number; message: string } };
    expect(r.error?.code).toBe(-32602);
  });
});
