import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-pre-compact-extract-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pre-compact-extract-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function callExtract(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath: null });
  await initialize(server);
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_pre_compact_extract", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_pre_compact_extract tool registration", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_pre_compact_extract"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_pre_compact_extract"),
    ).toBeUndefined();
  });
});

describe("brain_pre_compact_extract tool", () => {
  test("emits sanitized typed continuity records idempotently", async () => {
    const args = {
      session_id: "session-mcp",
      turn_start: "turn-1",
      turn_end: "turn-2",
      text: "Rule: Stay opt-in.\nCommitment: Remove data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    };
    const first = await callExtract(args);
    const second = await callExtract(args);

    expect(first).toMatchObject({ count: 2, errors: [] });
    expect(second).toMatchObject({ count: 2, errors: [] });
    expect((first.records as Array<{ id: string }>).map((record) => record.id)).toEqual(
      (second.records as Array<{ id: string }>).map((record) => record.id),
    );
    expect(JSON.stringify(first)).not.toContain("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo");
  });
});
