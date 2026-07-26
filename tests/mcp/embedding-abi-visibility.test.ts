/**
 * Embedding-ABI drift on the MCP surface (context-integrity-gates,
 * Unit E).
 *
 * The gated comparison landed on the read-mode open, but every consumer
 * of its result was a CLI one: `o2b search status` printed a warning and
 * `o2b search check` reported the structured mismatch. The MCP surface -
 * the primary consumer of this product - saw neither.
 * `buildSearchStatusBlock` destructured the whole `warnings` array away,
 * and the query path had no ABI branch at all, so an agent driving the
 * vault over MCP was served semantic results from a mismatched vector
 * table with nothing to observe at any setting short of `fail`.
 *
 * These tests pin both halves of the fix: the diagnostic
 * (`second_brain_status`) and the degraded read itself (`brain_search`).
 *
 * Vector assertions are skipped where sqlite-vec cannot be loaded,
 * following the repository-wide `sqliteVecLoadable()` pattern; the
 * embedding provider is a loopback stub, never a real endpoint.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import {
  EMBEDDING_ABI_FIX_COMMAND,
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_VEC_VERSION_STATE_KEY,
  Store,
} from "../../src/core/search/store.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";

const QUERY = "lattice widgets";

let tmp: string;
let vault: string;
let configPath: string;
let server: FakeHttp;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-abi-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  server = await startFakeHttp();
  atomicWriteFileSync(
    configPath,
    [
      `vault: ${vault}`,
      "agent_name: claude",
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: ${server.url}`,
      "embedding_model: fake-model",
      "embedding_api_key: test-key",
      "embedding_dimension: 4",
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeMd(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

async function initialize(mcp: MCPServer): Promise<void> {
  await mcp.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "abi-test", version: "0" },
    },
  });
  await mcp.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

function call(mcp: MCPServer, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return mcp.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  }) as Promise<unknown>;
}

function extractToolResult(resp: unknown): Record<string, unknown> {
  const r = resp as {
    result?: {
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
    };
  };
  const content = r?.result?.content?.[0];
  if (content?.type === "text" && typeof content.text === "string") {
    return JSON.parse(content.text) as Record<string, unknown>;
  }
  if (r?.result?.structuredContent) return r.result.structuredContent;
  return (r?.result ?? {}) as Record<string, unknown>;
}

/** Index one embedded note so there are stored vectors to be wrong about. */
async function indexOneEmbeddedNote(): Promise<void> {
  writeMd("notes/a.md", `# A\n\n${QUERY} in a note with vectors.\n`);
  await indexVault(resolveSearchConfig({ vault, configPath }), { embeddings: true });
}

/**
 * Mutate recorded ABI state behind the stamp's back. The write open
 * re-stamps first, so the edit lands after `ensureEmbeddingModel` and
 * survives the close - the shape of a store written by another build.
 */
async function tamper(edit: (store: Store) => void): Promise<void> {
  const store = await Store.open(resolveSearchConfig({ vault, configPath }), { mode: "write" });
  edit(store);
  await store.close();
}

async function statusSearchBlock(): Promise<Record<string, unknown>> {
  const mcp = new MCPServer({ vault, configPath });
  await initialize(mcp);
  const body = extractToolResult(await call(mcp, "second_brain_status", {}));
  return body["search"] as Record<string, unknown>;
}

async function searchWarnings(): Promise<string[]> {
  const mcp = new MCPServer({ vault, configPath });
  await initialize(mcp);
  const body = extractToolResult(await call(mcp, "brain_search", { query: QUERY, limit: 5 }));
  return body["warnings"] as string[];
}

test("second_brain_status names the embedding-ABI drift it serves results under", async () => {
  if (!sqliteVecLoadable()) return;
  await indexOneEmbeddedNote();
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const search = await statusSearchBlock();
  const drift = search["embedding_abi"] as Array<Record<string, unknown>> | undefined;
  expect(drift).toBeDefined();
  const dim = drift!.find((m) => m["field"] === EMBEDDING_DIMENSION_STATE_KEY);
  expect(dim).toBeDefined();
  expect(dim!["recorded"]).toBe("8");
  expect(dim!["runtime"]).toBe("4");

  // The structured field says WHAT drifted; the warning says what to run.
  const warnings = (search["warnings"] as string[] | undefined) ?? [];
  expect(warnings.some((w) => w.includes(EMBEDDING_ABI_FIX_COMMAND))).toBe(true);
});

test("second_brain_status on a matching store carries neither the field nor a warning", async () => {
  if (!sqliteVecLoadable()) return;
  await indexOneEmbeddedNote();

  const search = await statusSearchBlock();
  expect("embedding_abi" in search).toBe(false);
  expect("warnings" in search).toBe(false);
});

test("brain_search warns that its semantic results came from a mismatched vector table", async () => {
  if (!sqliteVecLoadable()) return;
  await indexOneEmbeddedNote();
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const warnings = await searchWarnings();
  expect(
    warnings.some(
      (w) => w.includes(EMBEDDING_DIMENSION_STATE_KEY) && w.includes(EMBEDDING_ABI_FIX_COMMAND),
    ),
  ).toBe(true);
});

test("brain_search on a matching store adds no ABI warning", async () => {
  if (!sqliteVecLoadable()) return;
  await indexOneEmbeddedNote();

  const warnings = await searchWarnings();
  expect(warnings.some((w) => w.includes(EMBEDDING_ABI_FIX_COMMAND))).toBe(false);
});

test("an unrecorded vec_version is a status finding, not a per-query warning", async () => {
  if (!sqliteVecLoadable()) return;
  await indexOneEmbeddedNote();
  await tamper((s) => s.deleteState(EMBEDDING_VEC_VERSION_STATE_KEY));

  // Every store written before the stamp existed reads this way. It is
  // reported where an operator went looking...
  const search = await statusSearchBlock();
  const drift = (search["embedding_abi"] as Array<Record<string, unknown>> | undefined) ?? [];
  expect(drift.some((m) => m["field"] === EMBEDDING_VEC_VERSION_STATE_KEY)).toBe(true);

  // ...and NOT on every query, because an absent token cannot tell an
  // old store from a wrong one - the same rule that keeps `fail` from
  // refusing it.
  const warnings = await searchWarnings();
  expect(warnings.some((w) => w.includes(EMBEDDING_ABI_FIX_COMMAND))).toBe(false);
});
