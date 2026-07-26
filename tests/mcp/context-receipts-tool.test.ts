import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { emitObservedUse } from "../../src/core/brain/observed-use.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-context-receipts-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-context-receipts-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
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
      clientInfo: { name: "context-receipts-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callReceipts(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context_receipts", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_context_receipts tool registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((tool) => tool.name === "brain_context_receipts")).toBeDefined();
  });

  test("not registered in the writer-only tool table", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((tool) => tool.name === "brain_context_receipts")).toBeUndefined();
  });
});

describe("brain_context_receipts tool", () => {
  test("lists summaries and shows a full receipt by id", async () => {
    const receipt = emitContextReceipt(vault, {
      options: {
        host: "mcp-test",
        trigger: "pre_compress",
        createdAt: "2026-05-20T14:00:00.000Z",
        sessionId: "session-mcp",
      },
      finalText: "pre-compress pack text",
      items: [{ id: "pref-alpha", text: "Prefer crisp answers" }],
    });
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const list = await callReceipts(server, {
      operation: "list",
      trigger: "pre_compress",
    });
    expect(list["total"]).toBe(1);
    expect((list["receipts"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: receipt.id,
      trigger: "pre_compress",
      host: "mcp-test",
      item_count: 1,
    });

    const show = await callReceipts(server, {
      operation: "show",
      id: receipt.id,
    });
    expect(show["id"]).toBe(receipt.id);
    expect((show["payload"] as Record<string, unknown>)["session_id"]).toBe("session-mcp");
  });

  test("summary folds a session and joins the observed-use verdicts", async () => {
    for (const [createdAt, tokens] of [
      ["2026-05-21T14:00:00.000Z", 10],
      ["2026-05-21T14:05:00.000Z", 14],
    ] as const) {
      emitContextReceipt(vault, {
        options: {
          host: "mcp-test",
          trigger: "context_pack",
          createdAt,
          sessionId: "session-fold",
        },
        finalText: "pack",
        items: [{ id: "pref-alpha", path: "Brain/preferences/pref-alpha.md", tokens }],
      });
    }
    emitObservedUse(vault, {
      createdAt: "2026-05-21T14:10:00.000Z",
      host: "mcp-test",
      sessionId: "session-fold",
      entries: [{ id: "pref-alpha", path: "Brain/preferences/pref-alpha.md", verdict: "USED" }],
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const summary = await callReceipts(server, {
      operation: "summary",
      session_id: "session-fold",
    });
    expect(summary["recorded"]).toBe(true);
    expect(summary["receipt_count"]).toBe(2);
    expect(summary["distinct_items"]).toBe(1);
    expect(summary["item_total"]).toBe(2);
    expect(summary["truncated"]).toBe(false);
    const items = summary["items"] as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      id: "pref-alpha",
      injections: 2,
      tokens: 24,
      observed: { used: 1, ignored: 0, contradicted: 0, total: 1 },
    });
  });

  test("summary over a vault with no receipts says so instead of returning zeros", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const summary = await callReceipts(server, { operation: "summary" });
    expect(summary["recorded"]).toBe(false);
    expect(summary["receipt_count"]).toBeUndefined();
    expect(summary["items"]).toBeUndefined();
    expect(typeof summary["note"]).toBe("string");
  });

  test("a malformed window bound is INVALID_PARAMS, never an empty window", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    emitContextReceipt(vault, {
      options: {
        host: "unit",
        trigger: "context_pack",
        createdAt: "2026-06-01T10:00:00Z",
        sessionId: "s1",
      },
      items: [{ id: "pref-a", tokens: 1 }],
      finalText: "x",
    });
    const summarize = async (
      args: Record<string, unknown>,
    ): Promise<{ error?: { code: number; message: string } }> =>
      (await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 12,
        method: "tools/call",
        params: { name: "brain_context_receipts", arguments: { operation: "summary", ...args } },
      })) as { error?: { code: number; message: string } };

    // Before this, "yesterday" sorted after every stored timestamp and
    // the tool answered `recorded: false, note: "no receipts recorded
    // for this filter"` - a finding about the vault, for a typo.
    const [word, offset] = await Promise.all([
      summarize({ since: "yesterday" }),
      summarize({ until: "2026-06-01T10:00:00+03:00" }),
    ]);
    expect(word.error?.message).toContain("canonical UTC");
    expect(offset.error?.message).toContain("canonical UTC");
  });

  test("summary counts the receipts that carried nothing", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    emitContextReceipt(vault, {
      options: {
        host: "hook",
        trigger: "session_inject",
        createdAt: "2026-06-01T10:00:00Z",
        sessionId: "s2",
      },
      items: [],
      finalText: "degraded-to-cache injection",
    });
    const summary = await callReceipts(server, { operation: "summary", session_id: "s2" });
    expect(summary["receipt_count"]).toBe(1);
    expect(summary["item_total"]).toBe(0);
    expect(summary["empty_receipts"]).toBe(1);
    expect(summary["malformed_receipts"]).toBe(0);
  });

  test("an unknown operation names every branch", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 11,
      method: "tools/call",
      params: { name: "brain_context_receipts", arguments: { operation: "nope" } },
    })) as { error?: { message: string }; result?: { content: ReadonlyArray<{ text: string }> } };
    const text = response.error?.message ?? response.result?.content[0]?.text ?? "";
    expect(text).toContain("summary");
  });
});
