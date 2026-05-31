/**
 * MCP integration tests for `brain_search` and the `search.*`
 * enrichment on `second_brain_status`.
 *
 * Like the Brain MCP suite, these go through `MCPServer.handleRequest`
 * end-to-end — so registration, schema validation, error mapping, and
 * the actual search query are all exercised together.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { LATEST_SCHEMA_VERSION } from "../../src/core/search/schema.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-search-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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
      clientInfo: { name: "search-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

function call(
  server: MCPServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  }) as Promise<unknown>;
}

function makeServer(): MCPServer {
  return new MCPServer({ vault, configPath });
}

function writeMd(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function extractToolResult(resp: any): Record<string, unknown> {
  // MCP tool/call wraps the handler return value in { content: [{ type:"text", text: "<json>" }] }.
  const content = resp?.result?.content?.[0];
  if (content?.type === "text" && typeof content.text === "string") {
    return JSON.parse(content.text);
  }
  // Some servers also expose `structuredContent` directly; accept both.
  if (resp?.result?.structuredContent) return resp.result.structuredContent;
  return resp?.result ?? {};
}

test("brain_search is advertised by tools/list", async () => {
  const server = makeServer();
  await initialize(server);
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 10,
    method: "tools/list",
  })) as any;
  const tools = r.result.tools as Array<{ name: string }>;
  expect(tools.find((t) => t.name === "brain_search")).toBeDefined();
});

test("brain_search happy path returns paths and respects 600-char content cap", async () => {
  writeMd("notes/foo.md", "# Foo\n\n" + "fox ".repeat(400));
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", { query: "fox", limit: 5 });
  const body = extractToolResult(resp);
  const results = body["results"] as Array<{
    content: string;
    path: string;
    searchType: string;
    score: number;
  }>;
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]?.path).toBe("notes/foo.md");
  expect(results[0]?.content.length).toBeLessThanOrEqual(600);
  // The MCP shape does NOT expose diagnostic score components.
  expect((results[0] as Record<string, unknown>)["keywordScore"]).toBeUndefined();
});

test("brain_search accepts structured query_document", async () => {
  writeMd("notes/final.md", "# Final\n\nrelease notes mention recall diagnostics.");
  writeMd("notes/draft.md", "# Draft\n\ndraft release notes mention recall diagnostics.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", {
    query: "release notes",
    query_document: 'lex: "release notes" -draft',
    limit: 10,
  });
  const body = extractToolResult(resp);
  const results = body["results"] as Array<{ path: string; reasons: string[] }>;

  expect(results.map((result) => result.path)).toContain("notes/final.md");
  expect(results.map((result) => result.path)).not.toContain("notes/draft.md");
  expect(results[0]?.reasons.some((reason) => reason.includes("lane:lex/fts5"))).toBe(true);
});

test("brain_search accepts explicit session focus input", async () => {
  writeMd("archive/other.md", "# Other\n\nshared recall topic.");
  writeMd("sessions/focus.md", "# Focus\n\nshared recall topic.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", {
    query: "shared",
    focus_path_prefix: "sessions/",
    limit: 2,
  });
  const body = extractToolResult(resp);
  const results = body["results"] as Array<{ path: string; reasons: string[] }>;

  expect(results[0]?.path).toBe("sessions/focus.md");
  expect(results[0]?.reasons.some((reason) => reason.startsWith("session_focus:"))).toBe(true);
});

test("brain_recall_gate reports skip reasons without affecting explicit brain_search", async () => {
  writeMd("notes/shell.md", "# Shell\n\ngit status troubleshooting note.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const gate = await call(server, "brain_recall_gate", {
    prompt: "git status",
  });
  expect(extractToolResult(gate)).toEqual({
    retrieve: false,
    reason: "shell_command",
  });

  const explicit = await call(server, "brain_search", {
    query: "git status",
    limit: 1,
  });
  const body = extractToolResult(explicit);
  const results = body["results"] as Array<{ path: string }>;
  expect(results[0]?.path).toBe("notes/shell.md");
});

test("brain_search evidence_pack returns missing terms and why_retrieved", async () => {
  writeMd("notes/foo.md", "# Foo\n\nalpha beta current support.");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "brain_search", {
    query: "alpha gamma",
    query_document: "lex: alpha",
    evidence_pack: true,
    limit: 5,
  });
  const body = extractToolResult(resp);
  const evidencePack = body["evidence_pack"] as { missing_terms: string[] };
  const results = body["results"] as Array<{ why_retrieved: string[] }>;

  expect(evidencePack.missing_terms).toContain("gamma");
  expect(Array.isArray(results[0]?.why_retrieved)).toBe(true);
});

test("brain_search rejects missing query with INVALID_PARAMS", async () => {
  const server = makeServer();
  await initialize(server);
  const resp = (await call(server, "brain_search", {})) as any;
  expect(resp?.error).toBeDefined();
  expect(resp.error.code).toBe(-32602); // INVALID_PARAMS
});

test("brain_search rejects path_prefix that escapes vault", async () => {
  writeMd("a.md", "# A");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = (await call(server, "brain_search", {
    query: "A",
    path_prefix: "../etc/",
  })) as any;
  expect(resp?.error?.code).toBe(-32602);
  expect(resp.error.message).toContain("path_prefix");
});

test("brain_search on missing index surfaces INTERNAL_ERROR with hint", async () => {
  const server = makeServer();
  await initialize(server);
  const resp = (await call(server, "brain_search", { query: "fox" })) as any;
  expect(resp?.error?.code).toBe(-32603); // INTERNAL_ERROR
  expect(resp.error.message).toMatch(/not initialised|index/i);
});

test("brain_search rejects limit > 50", async () => {
  writeMd("a.md", "# A");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = (await call(server, "brain_search", {
    query: "A",
    limit: 100,
  })) as any;
  expect(resp?.error?.code).toBe(-32602);
});

test("second_brain_status includes search block after indexing", async () => {
  writeMd("a.md", "# A\n\nbody");
  const cfg = resolveSearchConfig({ vault, configPath });
  await indexVault(cfg);

  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "second_brain_status", {});
  const body = extractToolResult(resp);
  const search = body["search"] as Record<string, unknown> | undefined;
  expect(search).toBeDefined();
  expect(search!["exists"]).toBe(true);
  expect(search!["documents"]).toBe(1);
  expect(search!["schema_version"]).toBe(LATEST_SCHEMA_VERSION);
});

test("second_brain_status reports search.exists=false when index missing", async () => {
  const server = makeServer();
  await initialize(server);
  const resp = await call(server, "second_brain_status", {});
  const body = extractToolResult(resp);
  const search = body["search"] as Record<string, unknown> | undefined;
  expect(search).toBeDefined();
  expect(search!["exists"]).toBe(false);
  expect(search!["hint"]).toMatch(/o2b search index/);
});
