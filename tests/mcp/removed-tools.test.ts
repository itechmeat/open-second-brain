/**
 * 1.0.0 deprecation sweep (epic t_a77ade0a): the 18 hidden alias
 * tools from the token-diet pass are removed from the callable
 * surface and replaced by static tombstones. Calling a removed name
 * answers INVALID_PARAMS with the exact replacement (tool + view);
 * the advertised list is unchanged and the shadow surface is gone -
 * after 1.0.0 the listed tools and the callable tools are the same
 * set.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable, REMOVED_TOOLS } from "../../src/mcp/tools.ts";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-removed-"));
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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
      clientInfo: { name: "removed-tools-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

/** Every removed alias with its consolidated replacement. */
const EXPECTED_TOMBSTONES: ReadonlyArray<readonly [string, string, string]> = [
  ["brain_digest", "brain_brief", "digest"],
  ["brain_daily_brief", "brain_brief", "daily"],
  ["brain_morning_brief", "brain_brief", "morning"],
  ["brain_weekly_synthesis", "brain_brief", "weekly"],
  ["brain_monthly_review", "brain_brief", "monthly"],
  ["brain_operator_summary", "brain_brief", "operator"],
  ["brain_attention_flows", "brain_analytics", "attention_flows"],
  ["brain_concept_synthesis", "brain_analytics", "concept_synthesis"],
  ["brain_timeline", "brain_analytics", "timeline"],
  ["brain_belief_evolution", "brain_analytics", "belief_evolution"],
  ["get_active_schema_pack", "schema_inspect", "active_pack"],
  ["list_schema_packs", "schema_inspect", "packs"],
  ["schema_stats", "schema_inspect", "stats"],
  ["schema_lint", "schema_inspect", "lint"],
  ["schema_graph", "schema_inspect", "graph"],
  ["schema_explain_type", "schema_inspect", "explain_type"],
  ["schema_review_orphans", "schema_inspect", "orphans"],
  ["reload_schema_pack", "schema_inspect", "active_pack"],
];

test("REMOVED_TOOLS covers exactly the 18 swept aliases", () => {
  expect(Object.keys(REMOVED_TOOLS).toSorted()).toEqual(
    EXPECTED_TOMBSTONES.map(([name]) => name).toSorted(),
  );
});

test("calling a removed tool answers INVALID_PARAMS naming the replacement", async () => {
  const server = new MCPServer({ vault: tmp });
  await initialize(server);
  const responses = await Promise.all(
    EXPECTED_TOMBSTONES.map(async ([name, target, view], i) => {
      const r = (await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 100 + i,
        method: "tools/call",
        params: { name, arguments: {} },
      })) as { error?: { code: number; message: string } };
      return { name, target, view, r };
    }),
  );
  for (const { name, target, view, r } of responses) {
    expect(r.error).toBeDefined();
    expect(r.error!.code).toBe(-32602);
    expect(r.error!.message).toContain(`${name} was removed in 1.0.0`);
    expect(r.error!.message).toContain(target);
    expect(r.error!.message).toContain(`view="${view}"`);
  }
});

test("a genuinely unknown tool still answers METHOD_NOT_FOUND", async () => {
  const server = new MCPServer({ vault: tmp });
  await initialize(server);
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 8,
    method: "tools/call",
    params: { name: "brain_never_existed", arguments: {} },
  })) as { error?: { code: number } };
  expect(r.error).toBeDefined();
  expect(r.error!.code).toBe(-32601);
});

test("the shadow surface is gone: no hidden tools, removed names unlisted", async () => {
  const all = buildToolTable("full");
  expect(all.filter((t) => t.hidden === true)).toEqual([]);
  const names = new Set(all.map((t) => t.name));
  for (const [name] of EXPECTED_TOMBSTONES) {
    expect(names.has(name)).toBe(false);
  }
  // The advertised list is what 0.45.0 advertised - the sweep removes
  // only the hidden callable layer.
  const server = new MCPServer({ vault: tmp });
  await initialize(server);
  const list = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/list",
    params: {},
  })) as { result: { tools: Array<{ name: string }> } };
  // 76 + brain_create_note (Brain Portability & Interop Suite) = 77.
  // + brain_file_context (Recall & Working-Memory Quality Suite) = 78.
  // + brain_session_summary, brain_idea_lineage, brain_note_history
  //   (Session Knowledge Synthesis Suite) = 81.
  // + brain_codegraph_report (CodeGraph & MCP Operational Readability) = 82.
  // + brain_generation_reports (Hindsight brain-loop ops) = 83.
  // + brain_obligation, brain_agenda (Calendar integration) = 85.
  // + brain_memory_bridge (Hermes on_memory_write host bridge) = 86.
  // + brain_event_trace (dashboard-context-trace: event→trace join) = 87.
  // + brain_search_expand (progressive disclosure: search→expand→transcript) = 88.
  expect(list.result.tools.length).toBe(88);
});
