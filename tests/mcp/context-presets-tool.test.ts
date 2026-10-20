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
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
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
        current: {
          context_pack: { max_tokens: 9000 },
          overrides: ["context_pack.max_tokens"],
        },
      }),
    ).resolves.toMatchObject({
      preset_id: "tight-context",
      preserved_overrides: [{ path: "context_pack.max_tokens", current: 9000, preset: 4000 }],
    });
  });

  test("a model-only suggest resolves the window and discloses the source", async () => {
    await expect(callPresets({ operation: "suggest", model: "gpt-4o" })).resolves.toMatchObject({
      preset_id: "long-context",
      confidence: "high",
      reason: "context window 128000 tokens resolved from declared matched long-context",
    });
    // Unknown model, no hint: nothing published places the id, so the
    // conservative fallback answers - the same tight-context/low answer a
    // model-free call gets. The pack budget surfaces refuse the same id
    // instead of budgeting the default window's long-context.
    await expect(callPresets({ operation: "suggest", model: "kimi-k2" })).resolves.toMatchObject({
      preset_id: "tight-context",
      confidence: "low",
      reason: "no model or context-window hint matched; using conservative default",
    });
    // The disagreeing-model case: "gpt-4.1-mini" matches the "mini" hint
    // AND the declared table. The suggestion must name the long-context
    // mapping the pack budget derives from, not the hint's tight-context.
    await expect(
      callPresets({ operation: "suggest", model: "gpt-4.1-mini" }),
    ).resolves.toMatchObject({
      preset_id: "long-context",
      confidence: "high",
      reason: "context window 1000000 tokens resolved from declared matched long-context",
    });
    // No model and no window keeps the conservative fallback.
    await expect(callPresets({ operation: "suggest" })).resolves.toMatchObject({
      preset_id: "tight-context",
      confidence: "low",
    });
  });

  test("a hint-only model answers its hint, the mapping the pack budget derives", async () => {
    // "gemini-2.5-flash" is unknown to the declared table: the resolver
    // answers the default window, but the hint decides on BOTH surfaces -
    // this suggest answer and the pack budget derivation that applies the
    // same fallback when the resolver's source is "default".
    await expect(
      callPresets({ operation: "suggest", model: "gemini-2.5-flash" }),
    ).resolves.toMatchObject({
      preset_id: "tight-context",
      confidence: "high",
      reason: "model hint matched tight-context",
    });
  });
});
