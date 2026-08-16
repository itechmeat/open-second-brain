/**
 * How a broken `Brain/_brain.yaml` reaches an MCP caller.
 *
 * The absent-versus-broken config split (96b14d72) made five readers
 * raise on a config that is present and unreadable. Two MCP surfaces sit
 * directly on those readers and answer the same condition differently on
 * purpose:
 *
 *   - `brain_feedback` REFUSES. The raise lands before the durable write,
 *     because a signal recorded under a silently wrong scope is a record
 *     no later fix reaches.
 *   - `brain_pre_compress_pack` DELIVERS, with the breakage named. It is
 *     read-only and it runs at compaction, where a refusal costs the
 *     agent every memory it was about to lose anyway.
 *
 * Both are asserted here so the asymmetry is deliberate and visible
 * rather than an accident of which call site had a guard.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { brainConfigUnreadableReport } from "../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

/** Parses as YAML, fails validation, in a block neither tool reads. */
const BROKEN_CONFIG = `schema_version: 1\ndream:\n  candidate_threshold: 0\n`;

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-broken-config-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-broken-config-cfg-"));
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

function breakConfig(): void {
  writeFileSync(brainConfigPath(vault), BROKEN_CONFIG, "utf8");
}

function inboxSignalCount(): number {
  return readdirSync(join(vault, "Brain", "inbox")).filter((n) => n.startsWith("sig-")).length;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: string }> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "broken-config-test", version: "0" },
    },
  });
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (r.error) return { error: r.error.message };
  const text = r.result!.content[0]!.text;
  if (r.result!.isError) return { error: text };
  return { result: JSON.parse(text) as Record<string, unknown> };
}

describe("brain_feedback refuses before the write", () => {
  test("an absent config records the signal, scope-less", async () => {
    const { result, error } = await callTool("brain_feedback", {
      topic: "cold-start",
      signal: "positive",
      principle: "Record the signal on a vault with no config.",
    });
    expect(error).toBeUndefined();
    expect(result?.["id"]).toBeDefined();
    expect(inboxSignalCount()).toBe(1);
  });

  test("an unreadable config errors by name and writes no signal", async () => {
    breakConfig();
    const { error } = await callTool("brain_feedback", {
      topic: "broken-config",
      signal: "positive",
      principle: "This must not be recorded under a guessed scope.",
    });
    expect(error).toBeDefined();
    expect(error!).toContain(brainConfigPath(vault));
    expect(inboxSignalCount()).toBe(0);
  });
});

describe("brain_pre_compress_pack delivers with the breakage named", () => {
  test("an absent config yields a pack and no warnings key", async () => {
    const { result, error } = await callTool("brain_pre_compress_pack", { top_k: 5 });
    expect(error).toBeUndefined();
    expect(result).toBeDefined();
    expect(result!["warnings"]).toBeUndefined();
  });

  test("an unscoped call on an unreadable config still returns a pack", async () => {
    breakConfig();
    const { result, error } = await callTool("brain_pre_compress_pack", { top_k: 5 });
    expect(error).toBeUndefined();
    expect(result?.["total_chars"]).toBeDefined();
  });

  test("the pack payload names the config the operator has to fix", async () => {
    breakConfig();
    const { result } = await callTool("brain_pre_compress_pack", { top_k: 5 });
    expect(result!["warnings"]).toEqual([brainConfigUnreadableReport(vault)!]);
    expect(result!["active_head_included"]).toBe(false);
  });

  test("a SCOPED call on an unreadable config is refused, not delivered", async () => {
    // The two rules that meet here, and which one wins.
    //
    // This surface is fail-soft: it delivers a pack and names the broken
    // config rather than going dark. And an unreadable config resolves to
    // the STRICT integrity fallback precisely so it "cannot loosen a gate,
    // it can only close one" (`policy/load.ts`). A call that names an
    // owner scope asks to be answered AS that owner, and under the closed
    // gate no such claim can be verified - so honouring it would be the
    // unreadable config loosening the very gate the fallback closed.
    //
    // Fail-soft therefore keeps its meaning for the unscoped call above,
    // and stops short of answering a scope this server cannot check.
    breakConfig();
    const { result, error } = await callTool("brain_pre_compress_pack", {
      top_k: 5,
      agent_scope: "agent-a",
    });
    expect(result).toBeUndefined();
    expect(error).toContain("unresolved-identity");
    expect(error).toContain("owner_scope_delivery");
  });
});
