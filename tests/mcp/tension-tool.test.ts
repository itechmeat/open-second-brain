import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { persistTension } from "../../src/core/brain/tensions.ts";
import type { NoteContradictionFinding } from "../../src/core/brain/health/contradiction.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-tension-tool-"));
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
      clientInfo: { name: "tension-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_tension", arguments: args },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

function seed(): string {
  const finding: NoteContradictionFinding = {
    aId: "pref-tabs",
    bId: "pref-spaces",
    subject: "tabs use",
    jaccard: 0.6,
    aSign: "positive",
    bSign: "negative",
    aQuote: "Always use tabs.",
    bQuote: "Never use tabs.",
    action: "ask_user",
  };
  return persistTension(vault, finding, { agent: "tester" }).record.slug;
}

describe("brain_tension tool", () => {
  test("registered in the full tool table", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_tension")).toBeDefined();
  });

  test("lists and transitions a tension", async () => {
    const slug = seed();
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);

    const listed = payload(await call(server, { action: "list" }));
    expect((listed["tensions"] as unknown[]).length).toBe(1);

    const confirmed = payload(await call(server, { action: "confirm", slug }));
    expect(confirmed["status"]).toBe("confirmed");

    const resolved = payload(await call(server, { action: "resolve", slug, reason: "merged" }));
    expect(resolved["status"]).toBe("resolved");
  });

  test("an invalid transition returns an error", async () => {
    const slug = seed();
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, { action: "dismiss", slug });
    const bad = await call(server, { action: "confirm", slug });
    expect(bad.error).toBeDefined();
  });
});
