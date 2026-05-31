import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-context-receipts-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-context-receipts-cfg-"));
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
      clientInfo: { name: "context-receipts-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callReceipts(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context_receipts", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_context_receipts tool registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((tool) => tool.name === "brain_context_receipts")).toBeDefined();
  });

  test("not registered in the writer-only tool table", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((tool) => tool.name === "brain_context_receipts")).toBeUndefined();
  });
});

describe("brain_context_receipts tool", () => {
  test("lists summaries and shows a full receipt by id", async () => {
    const receipt = emitContextReceipt(vault, {
      options: {
        host: "mcp-test",
        trigger: "pre_compress",
        createdAt: "2026-05-20T14:00:00.000Z",
        sessionId: "session-mcp",
      },
      finalText: "pre-compress pack text",
      items: [{ id: "pref-alpha", text: "Prefer crisp answers" }],
    });
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const list = await callReceipts(server, { operation: "list", trigger: "pre_compress" });
    expect(list["total"]).toBe(1);
    expect((list["receipts"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: receipt.id,
      trigger: "pre_compress",
      host: "mcp-test",
      item_count: 1,
    });

    const show = await callReceipts(server, { operation: "show", id: receipt.id });
    expect(show["id"]).toBe(receipt.id);
    expect((show["payload"] as Record<string, unknown>)["session_id"]).toBe("session-mcp");
  });
});
