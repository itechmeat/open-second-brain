/**
 * `brain_search` surfaces a result page's typed frontmatter relations
 * (typed graph semantics, unit 2). Exercises the tool through the same
 * handler path the MCP server uses, against a freshly indexed vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "search-relations-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as Record<string, any>;
}

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rel-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-rel-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "alpha.md"),
    [
      "---",
      "title: Alpha",
      "contradicts: [[beta]]",
      'superseded_by: "[[gamma]]"',
      "---",
      "",
      "The quick brown fox jumps over the lazy dog.",
    ].join("\n"),
  );
  ctx = { vault, configPath };
  const config = resolveSearchConfig({ vault, configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search typed relations", () => {
  test("a result page's declared relations surface inline", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search");
    expect(tool).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool!.handler(ctx as any, { query: "quick fox" })) as {
      results: Array<{ path: string; relations?: Array<{ relation: string; target: string }> }>;
    };
    const hit = out.results.find((r) => r.path.endsWith("alpha.md"));
    expect(hit).toBeDefined();
    const summary = (hit!.relations ?? []).map((r) => `${r.relation}:${r.target}`).toSorted();
    expect(summary).toEqual(["contradicts:beta", "superseded_by:gamma"]);
  });

  test("a result page with no relations omits the field", async () => {
    writeFileSync(
      join(vault, "notes", "plain.md"),
      "---\ntitle: Plain\n---\n\nThe quick brown fox again, plainly.",
    );
    const config = resolveSearchConfig({ vault, configPath: ctx.configPath });
    await indexVault(config, {});

    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool.handler(ctx as any, { query: "plainly" })) as {
      results: Array<{ path: string; relations?: unknown }>;
    };
    const hit = out.results.find((r) => r.path.endsWith("plain.md"));
    expect(hit).toBeDefined();
    expect(hit!.relations).toBeUndefined();
  });

  test("cards and expand output contract accepts exhausted cursor", async () => {
    writeFileSync(join(vault, "notes", "untitled.md"), "Unique exhausted cursor search term.\n");
    const config = resolveSearchConfig({ vault, configPath: ctx.configPath });
    await indexVault(config, {});

    const server = new MCPServer({ vault, configPath: ctx.configPath });
    await initialize(server);
    const searchResponse = await callTool(server, "brain_search", {
      query: "exhausted cursor",
      disclosure: "cards",
      limit: 1,
    });
    expect(searchResponse.result?.isError).toBe(false);
    const card = searchResponse.result.structuredContent.cards[0];
    expect(card.title).toBe("untitled");

    const expandResponse = await callTool(server, "brain_search_expand", {
      chunk_id: card.chunk_id,
      raw_limit: 50,
    });
    expect(expandResponse.result?.isError).toBe(false);
    expect(expandResponse.result.structuredContent.note.title).toBe("untitled");
    expect(expandResponse.result.structuredContent.next_cursor).toBeNull();
  });
});
