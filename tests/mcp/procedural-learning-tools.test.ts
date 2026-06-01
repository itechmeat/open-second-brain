import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-procedural-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "skills", "release"), { recursive: true });
  writeFileSync(
    join(vault, "skills", "release", "SKILL.md"),
    [
      "---",
      "triggers: [release]",
      "tags: [ops]",
      "permissions: [read]",
      "source: mcp-test",
      "version: 1",
      "---",
      "# Release skill",
    ].join("\n") + "\n",
    "utf8",
  );
  seedContinuity(vault);
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
      clientInfo: { name: "procedural-tools-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("procedural learning tool registration", () => {
  test("new tools are in full scope only", () => {
    for (const name of [
      "brain_skill_proposals",
      "brain_procedural_memory",
      "brain_procedural_graph",
      "brain_recurrence",
      "brain_attention_flows",
    ] as const) {
      expect(buildToolTable("full").find((tool) => tool.name === name)).toBeDefined();
      expect(buildToolTable("writer").find((tool) => tool.name === name)).toBeUndefined();
    }
  });
});

describe("procedural learning MCP tools", () => {
  test("skill proposals, procedural memory, procedural graph, and recurrence work end-to-end", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);

    const learned = await callTool(server, "brain_skill_proposals", {
      operation: "learn",
      min_support: 3,
    });
    expect((learned.created as unknown[]).length).toBeGreaterThanOrEqual(1);

    const listed = await callTool(server, "brain_skill_proposals", {
      operation: "list",
    });
    const proposals = listed.proposals as Array<Record<string, unknown>>;
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const slug = proposals[0]!["slug"] as string;

    const accepted = await callTool(server, "brain_skill_proposals", {
      operation: "accept",
      slug,
      note: "accepted in test",
    });
    expect(accepted.status).toBe("accepted");

    const rec = await callTool(server, "brain_procedural_memory", {
      operation: "reconcile",
      roots: [join(vault, "Brain", "procedures"), join(vault, "skills")],
    });
    expect(rec.total).toBeGreaterThanOrEqual(1);

    const mem = await callTool(server, "brain_procedural_memory", {
      operation: "list",
    });
    const entries = mem.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const marked = await callTool(server, "brain_procedural_memory", {
      operation: "mark_used",
      id: entries[0]!["id"],
    });
    expect(marked.usedCount).toBeGreaterThanOrEqual(1);

    const graphRebuild = await callTool(server, "brain_procedural_graph", {
      operation: "rebuild",
    });
    expect(graphRebuild.operation).toBe("rebuild");
    expect((graphRebuild.graph as Record<string, unknown>).nodes as number).toBeGreaterThan(0);

    const graphShow = await callTool(server, "brain_procedural_graph", {
      operation: "show",
    });
    expect((graphShow.nodes as unknown[]).length).toBeGreaterThan(0);

    const graphHints = await callTool(server, "brain_procedural_graph", {
      operation: "hints",
    });
    expect((graphHints.entries as unknown[]).length).toBeGreaterThan(0);

    const flowsList = await callTool(server, "brain_attention_flows", {
      operation: "list",
    });
    expect(flowsList.total).toBeGreaterThan(0);
    const flowId = (flowsList.flows as Array<Record<string, unknown>>)[0]!["id"] as string;

    const flowsEval = await callTool(server, "brain_attention_flows", {
      operation: "evaluate",
      flow_id: flowId,
    });
    expect((flowsEval.sections as unknown[]).length).toBeGreaterThan(0);

    const flowsRender = await callTool(server, "brain_attention_flows", {
      operation: "render",
      flow_id: flowId,
    });
    expect(flowsRender.flow_id).toBe(flowId);
    expect(typeof flowsRender.text).toBe("string");
    expect((flowsRender.text as string).length).toBeGreaterThan(0);

    const recLearn = await callTool(server, "brain_recurrence", {
      operation: "learn",
      content_hash: "h-mcp",
      scope: "project-a",
      source_id: "src-1",
    });
    expect(recLearn.operation).toBe("learn");

    const recShow = await callTool(server, "brain_recurrence", {
      operation: "show",
      content_hash: "h-mcp",
    });
    expect(recShow.supportCount).toBe(1);
  });
});

function seedContinuity(vaultPath: string): void {
  for (const row of [
    ["2026-06-01T08:00:00Z", "triage_inbox"],
    ["2026-06-02T08:00:00Z", "triage_inbox"],
    ["2026-06-03T08:00:00Z", "triage_inbox"],
    ["2026-06-01T08:05:00Z", "prepare_release_notes"],
    ["2026-06-02T08:05:00Z", "prepare_release_notes"],
    ["2026-06-03T08:05:00Z", "prepare_release_notes"],
  ] as const) {
    appendContinuityRecord(vaultPath, {
      kind: "session_turn",
      createdAt: row[0],
      sourceRefs: [{ id: `src-${row[0]}` }],
      payload: {
        action: row[1],
        summary: `Investigate issue ${row[0]}`,
      },
    });
  }
}
