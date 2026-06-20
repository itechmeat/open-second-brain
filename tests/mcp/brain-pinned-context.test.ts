/**
 * MCP integration tests for `brain_pinned_context` (t_c492e539):
 * atomic ordered-operations batch mode + terminal `done` marker on
 * successful writes. Drives the full server path so registration and
 * output-contract drift is caught here too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { brainPinnedPath } from "../../src/core/brain/paths.ts";
import { MAX_PINNED_CONTEXT_LEN } from "../../src/core/brain/pinned.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-pinned-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-pinned-cfg-"));
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
      clientInfo: { name: "pinned-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callPinned(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: { message: string; data?: unknown } }> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_pinned_context", arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }>; isError?: boolean };
    error?: { message: string; data?: unknown };
  };
  if (r.error) return { error: r.error };
  const text = r.result!.content[0]!.text;
  if (r.result!.isError) {
    return { error: { message: text } };
  }
  return { result: JSON.parse(text) };
}

describe("brain_pinned_context — terminal done marker", () => {
  test("single write returns done:true", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const { result } = await callPinned(server, { operation: "write", content: "hello" });
    expect(result?.["done"]).toBe(true);
    expect(result?.["content"]).toBe("hello");
  });

  test("read does not carry a done marker", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    await callPinned(server, { operation: "write", content: "x" });
    const { result } = await callPinned(server, { operation: "read" });
    expect(result?.["done"]).toBeUndefined();
  });
});

describe("brain_pinned_context — batch operations", () => {
  test("applies an ordered batch atomically and reports operations_applied", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const { result } = await callPinned(server, {
      operations: [
        { op: "write", content: "alpha" },
        { op: "append", content: "beta" },
        { op: "replace", find: "alpha", replace: "ALPHA" },
      ],
    });
    expect(result?.["done"]).toBe(true);
    expect(result?.["operations_applied"]).toBe(3);
    expect(result?.["content"]).toBe("ALPHA\n\nbeta");
    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe("ALPHA\n\nbeta\n");
  });

  test("a single over-budget write is rejected with a structured budget signal and no write", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const huge = "x".repeat(MAX_PINNED_CONTEXT_LEN + 100);
    const { result, error } = await callPinned(server, { operation: "write", content: huge });
    // No silent truncated success.
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect(error!.message).toContain("brain_pinned_context");
    const data = error!.data as Record<string, unknown> | undefined;
    expect(data?.["code"]).toBe("budget_exceeded");
    expect(data?.["budget"]).toBe(MAX_PINNED_CONTEXT_LEN);
    expect(data?.["length"]).toBe(huge.length);
    // Nothing persisted on disk.
    expect(() => readFileSync(brainPinnedPath(vault), "utf8")).toThrow();
  });

  test("a malformed middle op aborts with a structured error and no write", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    await callPinned(server, { operation: "write", content: "seed" });
    const before = readFileSync(brainPinnedPath(vault), "utf8");

    const { error } = await callPinned(server, {
      operations: [{ op: "append", content: "nope" }, { op: "frobnicate" }],
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain("brain_pinned_context");
    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe(before);
  });
});
