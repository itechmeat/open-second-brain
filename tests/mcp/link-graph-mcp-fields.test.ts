/**
 * MCP integration coverage for the v0.10.17 link-graph tools.
 * Verifies registration in the full tool scope, JSON-RPC round-trip
 * shape, and INVALID_PARAMS rejection of malformed input.
 *
 * Tools covered (extended as new v0.10.17 consumers ship):
 *   - brain_unlinked_mentions
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
} from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-link-graph-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-link-graph-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
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
      clientInfo: { name: "link-graph-test", version: "0" },
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
  id = 9,
): Promise<{ result?: { content: ReadonlyArray<{ type: string; text: string }> }; error?: { code: number; message: string } }> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }) as Promise<{ result?: { content: ReadonlyArray<{ type: string; text: string }> }; error?: { code: number; message: string } }>;
}

function writePref(
  slug: string,
  frontmatter: Record<string, string>,
  body = "",
): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`);
  lines.push("---", "", body);
  writeFileSync(join(vault, "Brain", "preferences", `${slug}.md`), lines.join("\n"));
}

describe("brain_unlinked_mentions registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((t) => t.name === "brain_unlinked_mentions")).toBeDefined();
  });

  test("NOT in the writer-only scope", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((t) => t.name === "brain_unlinked_mentions")).toBeUndefined();
  });
});

describe("brain_unlinked_mentions round trip", () => {
  test("returns mention list for matching prose", async () => {
    writePref(
      "pref-target",
      {
        kind: "preference",
        topic: "t",
        status: "confirmed",
        principle: "p",
        title: "Subject Line",
      },
    );
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "I think about Subject Line often.",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", {
      id: "pref-target",
    });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["target_id"]).toBe("pref-target");
    expect(Array.isArray(out["mentions"])).toBe(true);
    expect(out["mentions"].length).toBe(1);
    expect(out["mentions"][0]["source"]).toBe("pref-linker");
    expect(out["mentions"][0]["term"]).toBe("Subject Line");
  });

  test("empty vault returns empty mentions array", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", {
      id: "pref-missing",
    });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["mentions"]).toEqual([]);
  });

  test("rejects empty id with INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", { id: "" });
    expect(r.error?.code).toBe(-32602);
  });

  test("rejects negative limit with INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", {
      id: "pref-foo",
      limit: -1,
    });
    expect(r.error?.code).toBe(-32602);
  });

  test("rejects non-numeric limit with INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_unlinked_mentions", {
      id: "pref-foo",
      limit: "many",
    });
    expect(r.error?.code).toBe(-32602);
  });
});
