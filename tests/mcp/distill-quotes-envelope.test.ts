/**
 * A strict quote refusal reaches the wire with its registered code
 * (distilled provenance, D1).
 *
 * `wrapToolErrors` drops error data, so `brain_distill_source` maps
 * `QuoteCheckError` itself. This suite drives the real server so the code
 * is read where a client reads it - `error.data.code` on the JSON-RPC error
 * - and proves the refusal wrote nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QUOTE_UNVERIFIED_CODE } from "../../src/core/brain/distill/quote-verdict.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { BRAIN_DISTILLATIONS_REL } from "../../src/core/brain/path-constants.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import {
  INVALID_PARAMS,
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
} from "../../src/mcp/index.ts";
import { readRpcErrorCode } from "../helpers/tool-error-envelope.ts";

const TOOL = "brain_distill_source";
const SOURCE = "Articles/quoted.md";
const PARAPHRASE = { text: 'The author writes "settles all batches quickly".', block: "p1" };

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-envelope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-distill-envelope-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(
    join(vault, SOURCE),
    "# Quoted\n\nThe protocol settles every batch within one minute. ^p1\n",
    "utf8",
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

type Response = { result?: { content: ReadonlyArray<{ text: string }> }; error?: any };

async function call(args: Record<string, unknown>): Promise<Response> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "distill-envelope-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: TOOL, arguments: args },
  })) as Response;
}

/** Distillation pages on disk; the directory may not exist yet. */
function distillationPages(): string[] {
  const dir = join(vault, BRAIN_DISTILLATIONS_REL);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")) : [];
}

describe("brain_distill_source strict refusal on the wire", () => {
  test("answers a JSON-RPC error carrying quote_unverified and writes nothing", async () => {
    const res = await call({ source_path: SOURCE, claims: [PARAPHRASE], strict_quotes: true });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(INVALID_PARAMS);
    expect(readRpcErrorCode(res)).toBe(QUOTE_UNVERIFIED_CODE);
    expect(res.error.message).toStartWith(`${TOOL}: `);
    expect(res.error.message).toContain("claim 0: not-in-block");
    // The message names indices and outcomes, never the caller's words.
    expect(res.error.message).not.toContain("settles all batches quickly");
    expect(distillationPages()).toEqual([]);
  });

  test("without strict_quotes the same claim lands unquoted and is reported", async () => {
    const res = await call({ source_path: SOURCE, claims: [PARAPHRASE] });
    expect(res.error).toBeUndefined();
    const payload = JSON.parse(res.result!.content[0]!.text) as {
      quotes: { unquoted: number };
    };
    expect(payload.quotes.unquoted).toBe(1);
    expect(distillationPages()).toHaveLength(1);
  });
});
