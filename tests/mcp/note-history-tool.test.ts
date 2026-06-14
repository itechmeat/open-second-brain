import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

function git(env: Record<string, string>, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-C",
      vault,
      "-c",
      "user.name=Fix",
      "-c",
      "user.email=f@x.io",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...env } },
  );
}

function commit(rel: string, content: string, msg: string, iso: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  git({}, "add", "--", rel);
  git({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }, "commit", "-q", "-m", msg);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-note-history-tool-"));
  git({}, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "note-history-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(args: Record<string, unknown>): Promise<{ result?: unknown; error?: unknown }> {
  const server = new MCPServer({ vault, configPath: null });
  await initialize(server);
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_note_history", arguments: args },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("brain_note_history tool", () => {
  test("registered in the full tool table only", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_note_history")).toBeDefined();
    expect(buildToolTable("writer").find((t) => t.name === "brain_note_history")).toBeUndefined();
  });

  test("decomposes a note's history into phases on a gap", async () => {
    commit("notes/topic.md", "v1", "start", "2026-05-01T10:00:00Z");
    commit("notes/topic.md", "v2", "later", "2026-05-20T10:00:00Z");
    const out = payload(await call({ path: "notes/topic.md", gap_hours: 72 }));
    expect(out["available"]).toBe(true);
    expect(out["commit_count"]).toBe(2);
    expect((out["phases"] as unknown[]).length).toBe(2);
  });

  test("missing path is an invalid-params error", async () => {
    const response = await call({});
    expect((response.error as { code: number }).code).toBe(-32602);
  });
});
