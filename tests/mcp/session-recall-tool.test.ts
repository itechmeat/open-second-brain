import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import type { SessionTurn } from "../../src/core/brain/sessions/types.ts";
import {
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
} from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-session-recall-"));
  const turns: SessionTurn[] = [
    {
      turnId: "t1",
      role: "user",
      timestamp: "2026-05-20T17:00:01.000Z",
      text: "Need receipt search.",
    },
    {
      turnId: "t2",
      role: "assistant",
      timestamp: "2026-05-20T17:00:02.000Z",
      text: "Receipt summary.",
    },
  ];
  importSessionRecall(vault, {
    sessionId: "session-mcp",
    turns,
    summaryGroupSize: 2,
    createdAt: "2026-05-20T17:00:00.000Z",
  });
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
      clientInfo: { name: "session-recall-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath: null });
  await initialize(server);
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("session recall MCP tool registration", () => {
  test("registered in the full tool table only", () => {
    for (const name of [
      "brain_session_grep",
      "brain_session_describe",
      "brain_session_expand",
    ]) {
      expect(
        buildToolTable("full").find((tool) => tool.name === name),
      ).toBeDefined();
      expect(
        buildToolTable("writer").find((tool) => tool.name === name),
      ).toBeUndefined();
    }
  });
});

describe("session recall MCP tools", () => {
  test("grep, describe, and expand imported session recall records", async () => {
    const description = await callTool("brain_session_describe", {
      session_id: "session-mcp",
    });
    expect(description).toMatchObject({ raw_turns: 2, summary_nodes: 1 });

    const grep = await callTool("brain_session_grep", {
      query: "receipt",
      session_id: "session-mcp",
    });
    expect(
      (grep.hits as Array<{ kind: string }>).some(
        (hit) => hit.kind === "session_summary_node",
      ),
    ).toBe(true);

    const summary = (grep.hits as Array<{ id: string; kind: string }>).find(
      (hit) => hit.kind === "session_summary_node",
    )!;
    const expanded = await callTool("brain_session_expand", {
      id: summary.id,
      raw_limit: 1,
    });
    expect(expanded).toMatchObject({ next_cursor: "1" });
    expect(expanded.raw_content).toHaveLength(1);
  });
});
