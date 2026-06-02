/**
 * MCP integration tests for the read-only `brain_entity` tool
 * (Memory Integrity Suite). Writes stay on the CLI; the MCP surface
 * exposes lookup (`view: get`) and listing (`view: list`) only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

const NOW = new Date("2026-06-02T12:00:00Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-entity-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-entity-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  upsertEntity(vault, {
    category: "people",
    name: "Ada",
    aliases: ["the operator"],
    agent: "claude",
    now: NOW,
  });
  upsertEntity(vault, {
    category: "projects",
    name: "Open Second Brain",
    agent: "claude",
    now: NOW,
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
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
      clientInfo: { name: "entity-tool-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callEntity(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; payload: Record<string, unknown>; error?: string }> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 7,
    method: "tools/call",
    params: { name: "brain_entity", arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (r.error) return { ok: false, payload: {}, error: r.error.message };
  const text = r.result!.content[0]!.text;
  if (r.result!.isError) return { ok: false, payload: {}, error: text };
  return { ok: true, payload: JSON.parse(text) as Record<string, unknown> };
}

describe("brain_entity registration", () => {
  test("present in the full scope, absent from the writer scope", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_entity")).toBeDefined();
    expect(buildToolTable("writer").find((t) => t.name === "brain_entity")).toBeUndefined();
  });
});

describe("brain_entity view: get", () => {
  test("resolves an alias to the canonical record", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callEntity(server, { view: "get", query: "the operator" });
    expect(out.ok).toBe(true);
    expect(out.payload["id"]).toBe("ent-people-ada");
    expect(out.payload["name"]).toBe("Ada");
  });

  test("reports found:false for an unknown name", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callEntity(server, { view: "get", query: "nobody" });
    expect(out.ok).toBe(true);
    expect(out.payload["found"]).toBe(false);
  });

  test("requires query", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callEntity(server, { view: "get" });
    expect(out.ok).toBe(false);
  });
});

describe("brain_entity view: list", () => {
  test("lists all entities sorted by id, with category filter", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const all = await callEntity(server, { view: "list" });
    expect(all.ok).toBe(true);
    expect((all.payload["entities"] as Array<{ id: string }>).map((e) => e.id)).toEqual([
      "ent-people-ada",
      "ent-projects-open-second-brain",
    ]);
    const people = await callEntity(server, { view: "list", category: "people" });
    expect((people.payload["entities"] as Array<{ id: string }>).map((e) => e.id)).toEqual([
      "ent-people-ada",
    ]);
  });

  test("rejects an unknown view", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callEntity(server, { view: "explode" });
    expect(out.ok).toBe(false);
  });
});
