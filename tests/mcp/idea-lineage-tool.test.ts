import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { appendSessionSummary } from "../../src/core/brain/session-summary.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-idea-lineage-tool-"));
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
      clientInfo: { name: "idea-lineage-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(
  args: Record<string, unknown>,
  reach: TransportReach = TRANSPORT_REACH.local,
): Promise<{ result?: unknown; error?: unknown }> {
  const server = new MCPServer({ vault, configPath: null }, { reach });
  await initialize(server);
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_idea_lineage", arguments: args },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("brain_idea_lineage tool", () => {
  test("registered in the full tool table only", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_idea_lineage")).toBeDefined();
    expect(buildToolTable("writer").find((t) => t.name === "brain_idea_lineage")).toBeUndefined();
  });

  test("traces a digest back to its source turn", async () => {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-14T09:00:00.000Z",
      payload: { session_id: "s1", turn_id: "t1", role: "user", text: "trace me" },
    });
    const digest = appendSessionSummary(vault, {
      sessionId: "s1",
      decisions: ["d"],
      sourceTurnIds: ["t1"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    const out = payload(await call({ id: digest.id }));
    expect((out["root"] as Record<string, unknown>)["id"]).toBe(digest.id);
    const nodes = out["nodes"] as Array<Record<string, unknown>>;
    expect(nodes.some((n) => n["kind"] === "session_turn" && n["stage"] === "observation")).toBe(
      true,
    );
  });

  test("a private source turn is left out at remote reach only", async () => {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-14T09:00:00.000Z",
      private: true,
      payload: { session_id: "s1", turn_id: "t1", role: "user", text: "hidden detail" },
    });
    const digest = appendSessionSummary(vault, {
      sessionId: "s1",
      decisions: ["d"],
      sourceTurnIds: ["t1"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    const turnNodes = (out: Record<string, unknown>) =>
      (out["nodes"] as Array<Record<string, unknown>>).filter((n) => n["kind"] === "session_turn");
    expect(turnNodes(payload(await call({ id: digest.id })))).toHaveLength(1);
    const remote = payload(await call({ id: digest.id }, TRANSPORT_REACH.remote));
    expect(turnNodes(remote)).toHaveLength(0);
    expect(JSON.stringify(remote)).not.toContain("hidden detail");
  });

  test("missing id is an invalid-params error", async () => {
    const response = await call({});
    expect((response.error as { code: number }).code).toBe(-32602);
  });

  test("unknown id is an invalid-params error", async () => {
    const response = await call({ id: "ctn_nope" });
    expect((response.error as { code: number }).code).toBe(-32602);
  });
});
