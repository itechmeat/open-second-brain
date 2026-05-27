/**
 * MCP integration coverage for the v0.10.17 `brain_context` envelope
 * extension. When a vault-root instruction file (`VAULT.md` by
 * default) exists, the envelope grows a `vault_instruction` field;
 * absent file = field omitted so hosts that strip unknown fields
 * stay byte-identical.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-vault-instr-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-vault-instr-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
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
      clientInfo: { name: "vault-instr-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callContext(server: MCPServer): Promise<Record<string, unknown>> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context", arguments: {} },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text);
}

describe("brain_context envelope vault_instruction extension (v0.10.17)", () => {
  test("absent VAULT.md: envelope OMITS vault_instruction field", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callContext(server);
    expect("vault_instruction" in out).toBe(false);
  });

  test("present VAULT.md: envelope includes path + content + lines", async () => {
    writeFileSync(join(vault, "VAULT.md"), "# Project context\n\nI work on Open Second Brain.\n");
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callContext(server);
    expect(out["vault_instruction"]).toBeDefined();
    const vi = out["vault_instruction"] as {
      path: string;
      content: string;
      lines: number;
    };
    expect(vi.path).toBe("VAULT.md");
    expect(vi.content).toContain("Open Second Brain");
    expect(vi.lines).toBe(3);
  });

  test("configurable name: GUIDE.md picked up via _brain.yaml link_graph block", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nlink_graph:\n  vault_instruction_file: GUIDE.md\n",
    );
    writeFileSync(join(vault, "GUIDE.md"), "# Guide\n");
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callContext(server);
    const vi = out["vault_instruction"] as { path: string };
    expect(vi.path).toBe("GUIDE.md");
  });
});
