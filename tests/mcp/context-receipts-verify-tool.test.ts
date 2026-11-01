/**
 * The `verify` operation on `brain_context_receipts` (t_4300e5fd).
 *
 * The operation enum grows; the tool name does not, so the frozen
 * tool-name parity set stays untouched. Everything below rides the same
 * JSON-RPC harness the receipts suite uses, with receipts emitted
 * directly against temp-vault pages, and consumes exactly the K2
 * `ReceiptVerification` shape the kernel returns.
 *
 * The refusals: an unknown id is refused by name with the same
 * INVALID_PARAMS error `show` uses; a private or redacted receipt is
 * refused symmetrically with the session fold (withheld, never
 * unfolded); below local reach the answer is the typed refusal shape,
 * never a partial verify.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { RECEIPT_VERIFY_VERDICT } from "../../src/core/brain/context-receipts-verify.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { MCPServerRuntimeOptions } from "../../src/mcp/server.ts";

const PAGE_BODY = "Prefer terse answers over long preambles.\n";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-receipts-verify-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-receipts-verify-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of ["VAULT_DIR", "VAULT_AGENT_NAME", "OPEN_SECOND_BRAIN_CONFIG"]) {
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

function writePage(name: string, body: string): string {
  const abs = join(vault, "Brain", "preferences", name);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\nid: ${name.replace(/\.md$/, "")}\n---\n\n${body}`, "utf8");
  return abs;
}

/** Emit a context_pack receipt whose one item names `abs` and hashes the stripped body. */
function emitPageReceipt(abs: string, body: string) {
  return emitContextReceipt(vault, {
    options: {
      host: "mcp-verify-test",
      trigger: "context_pack",
      createdAt: "2026-06-01T09:00:00.000Z",
    },
    items: [{ id: "pref-verify", path: abs, text: body.trim() }],
    finalText: body.trim(),
  });
}

/**
 * Set a withholding flag on the stored record in place, as the
 * redaction path would leave it: same id, flag set.
 */
function flagStoredReceipt(id: string, flag: "private" | "redacted"): void {
  const storePath = join(vault, "Brain", "log", "continuity");
  const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  for (const shard of readdirSync(storePath)) {
    const shardPath = join(storePath, shard);
    const lines = readFileSync(shardPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const rewritten = lines.map((line) => {
      const record = JSON.parse(line) as { id: string } & Record<string, unknown>;
      if (record.id === id) return JSON.stringify({ ...record, [flag]: true });
      return line;
    });
    writeFileSync(shardPath, `${rewritten.join("\n")}\n`, "utf8");
  }
}

interface CallOutcome {
  readonly result: Record<string, unknown> | null;
  readonly error: { readonly code: number; readonly message: string } | null;
}

async function callVerify(
  runtime: MCPServerRuntimeOptions = {},
  args: Record<string, unknown> = {},
): Promise<CallOutcome> {
  // Local reach by default (the operator shell's posture, and the only
  // reach verify answers at); the remote-refusal case overrides it.
  const server = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local, ...runtime });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "receipts-verify-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context_receipts", arguments: { operation: "verify", ...args } },
  })) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }> };
    error?: { code: number; message: string };
  };
  if (response.error !== undefined) return { result: null, error: response.error };
  return {
    result: JSON.parse(response.result?.content[0]?.text ?? "null") as Record<string, unknown>,
    error: null,
  };
}

describe("brain_context_receipts verify registration", () => {
  test("the tool keeps its name and kind in the full table, absent from the writer table", () => {
    const full = buildToolTable("full");
    const tool = full.find((entry) => entry.name === "brain_context_receipts");
    expect(tool).toBeDefined();
    expect(tool!.kind).toBe("read");
    const operations = (
      tool!.inputSchema as { properties: { operation: { enum: ReadonlyArray<string> } } }
    ).properties.operation.enum;
    expect([...operations]).toEqual(["list", "show", "summary", "verify"]);
    expect(
      buildToolTable("writer").find((entry) => entry.name === "brain_context_receipts"),
    ).toBeUndefined();
  });
});

describe("brain_context_receipts verify operation", () => {
  test("verify returns the K2 shape over the JSON-RPC harness", async () => {
    const abs = writePage("pref-verify.md", PAGE_BODY);
    const receipt = emitPageReceipt(abs, PAGE_BODY);

    const { result, error } = await callVerify({}, { id: receipt.id });

    expect(error).toBeNull();
    expect(result).not.toBeNull();
    expect(result!["receiptId"]).toBe(receipt.id);
    expect(result!["createdAt"]).toBe(receipt.createdAt);
    expect(result!["trigger"]).toBe("context_pack");
    expect(result!["sessionInjected"]).toBe(false);
    const items = result!["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "pref-verify",
      verdict: RECEIPT_VERIFY_VERDICT.match,
      unavailableReason: null,
    });
    expect(result!["counts"]).toEqual({ match: 1, changed: 0, unavailable: 0 });
  });

  test("an unknown id is refused by name with the same error code show uses", async () => {
    const { result, error } = await callVerify({}, { id: "ctn_absent" });

    expect(result).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("receipt not found: ctn_absent");
    const showResponse = await (async () => {
      const server = new MCPServer({ vault, configPath });
      await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "receipts-verify-test", version: "0" },
        },
      });
      await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
      return (await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 9,
        method: "tools/call",
        params: {
          name: "brain_context_receipts",
          arguments: { operation: "show", id: "ctn_absent" },
        },
      })) as { error?: { code: number; message: string } };
    })();
    expect(error!.code).toBe(showResponse.error!.code);
  });

  test("a private receipt is refused symmetrically with the fold", async () => {
    const abs = writePage("pref-verify.md", PAGE_BODY);
    const receipt = emitPageReceipt(abs, PAGE_BODY);
    flagStoredReceipt(receipt.id, "private");

    const { result, error } = await callVerify({}, { id: receipt.id });

    expect(error).toBeNull();
    expect(result).toMatchObject({
      operation: "verify",
      measured: false,
      reason: "receipt_withheld",
    });
    expect(typeof result!["detail"]).toBe("string");
    expect(result!["items"]).toBeUndefined();
  });

  test("a redacted receipt is refused symmetrically with the fold", async () => {
    const abs = writePage("pref-verify.md", PAGE_BODY);
    const receipt = emitPageReceipt(abs, PAGE_BODY);
    flagStoredReceipt(receipt.id, "redacted");

    const { result, error } = await callVerify({}, { id: receipt.id });

    expect(error).toBeNull();
    expect(result).toMatchObject({
      operation: "verify",
      measured: false,
      reason: "receipt_withheld",
    });
  });

  test("below local reach the typed refusal is returned, never a partial verify", async () => {
    const abs = writePage("pref-verify.md", PAGE_BODY);
    const receipt = emitPageReceipt(abs, PAGE_BODY);

    const { result, error } = await callVerify(
      { reach: TRANSPORT_REACH.remote },
      { id: receipt.id },
    );

    expect(error).toBeNull();
    expect(result).toMatchObject({
      operation: "verify",
      measured: false,
      reason: "reach",
    });
    expect(typeof result!["detail"]).toBe("string");
    expect(result!["items"]).toBeUndefined();
    expect(result!["counts"]).toBeUndefined();
  });
});
