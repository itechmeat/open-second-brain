/**
 * MCP integration tests for the `brain_context` tool (v0.10.10).
 *
 * Drives §5 of `docs/plans/2026-05-20-v0.10.10-design.md` — the
 * read-only pull-bootstrap tool that returns `Brain/active.md`
 * verbatim plus counts for runtimes without a `SessionStart` hook
 * (Cursor, Aider, raw Claude API).
 *
 * Exercises the full server path (`MCPServer.handleRequest →
 * tools/call → handler`) so registration drift is caught here too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainActivePath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-brain-context-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-brain-context-cfg-"));
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
      clientInfo: { name: "brain-context-test", version: "0" },
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
    id: 7,
    method: "tools/call",
    params: { name: "brain_context", arguments: {} },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  // Tool returns are wrapped as `content: [{type:"text", text:"<json>"}]`.
  const text = r.result.content[0]!.text;
  return JSON.parse(text);
}

describe("brain_context tool registration", () => {
  test("appears in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((t) => t.name === "brain_context")).toBeDefined();
  });

  test("appears in the writer scope (always-loaded)", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((t) => t.name === "brain_context")).toBeDefined();
  });

  test("writer scope still hosts the three Brain writers", () => {
    const names = buildToolTable("writer")
      .map((t) => t.name)
      .toSorted();
    expect(names).toEqual(
      ["brain_apply_evidence", "brain_context", "brain_feedback", "brain_note"].toSorted(),
    );
  });
});

describe("brain_context tool — Brain absent", () => {
  test("returns present:false with empty content and zero counts", async () => {
    // No bootstrapBrain — Brain/ does not exist.
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callContext(server);
    expect(out["present"]).toBe(false);
    expect(out["content"]).toBe("");
    expect(out["generated_at"]).toBeNull();
    const counts = out["counts"] as Record<string, number>;
    expect(counts.confirmed).toBe(0);
    expect(counts.quarantine).toBe(0);
    expect(counts.retired_recent).toBe(0);
    expect(counts.most_applied_30d).toBe(0);
  });
});

describe("brain_context tool — Brain present", () => {
  beforeEach(() => {
    bootstrapBrain(vault, { configPath });
  });

  test("self-heals active.md when it is missing", async () => {
    // bootstrapBrain may already create active.md; remove it so we
    // exercise the regenerateActive self-heal path.
    const active = brainActivePath(vault);
    if (existsSync(active)) unlinkSync(active);

    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callContext(server);
    expect(out["present"]).toBe(true);
    expect(typeof out["content"]).toBe("string");
    expect(out["content"] as string).toContain("# Active Brain Preferences");
    expect(existsSync(active)).toBe(true);
  });

  test("returns the active.md body verbatim once it exists", async () => {
    writePreference(vault, {
      slug: "demo",
      topic: "demo",
      principle: "Demo principle",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: "medium",
      scope: "writing",
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callContext(server);
    const fromDisk = readFileSync(brainActivePath(vault), "utf8");
    expect(out["content"]).toBe(fromDisk);
    expect(typeof out["generated_at"]).toBe("string");
    const counts = out["counts"] as Record<string, number>;
    expect(counts.confirmed).toBe(1);
    expect(typeof counts.most_applied_30d).toBe("number");
  });

  test("two consecutive calls return byte-equal content", async () => {
    writePreference(vault, {
      slug: "demo",
      topic: "demo",
      principle: "Demo principle",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: "medium",
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const first = await callContext(server);
    const second = await callContext(server);
    expect(second["content"]).toBe(first["content"]);
    expect(second["generated_at"]).toBe(first["generated_at"]);
  });
});
