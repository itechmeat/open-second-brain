import { describe, expect, test } from "bun:test";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "context-presets-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function callPresets(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault: process.cwd(), configPath: null });
  await initialize(server);
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context_presets", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_context_presets tool registration", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_context_presets"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_context_presets"),
    ).toBeUndefined();
  });
});

describe("brain_context_presets tool", () => {
  test("shows, suggests, and diffs presets", async () => {
    await expect(
      callPresets({ operation: "show", preset_id: "tight-context" }),
    ).resolves.toMatchObject({
      id: "tight-context",
      context_pack: { max_tokens: 4000 },
    });
    await expect(
      callPresets({
        operation: "suggest",
        model: "claude-sonnet-4",
        context_window_tokens: 200000,
      }),
    ).resolves.toMatchObject({ preset_id: "long-context", confidence: "high" });
    await expect(
      callPresets({
        operation: "diff",
        preset_id: "tight-context",
        current: { context_pack: { max_tokens: 9000 }, overrides: ["context_pack.max_tokens"] },
      }),
    ).resolves.toMatchObject({
      preset_id: "tight-context",
      preserved_overrides: [{ path: "context_pack.max_tokens", current: 9000, preset: 4000 }],
    });
  });
});
