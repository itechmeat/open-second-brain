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

const DERIVED_KEYS = new Set([
  "status",
  "applied_count",
  "violated_count",
  "last_evidence_at",
  "confidence",
  "confidence_value",
  "evidenced_by",
  "contradicted_by",
  "lifecycle",
  "confirmed_at",
]);

function writePref(
  slug: string,
  frontmatter: Record<string, string>,
  body = "",
): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    const key = DERIVED_KEYS.has(k) ? `_${k}` : k;
    lines.push(`${key}: ${v}`);
  }
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

describe("brain_moc_audit registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((t) => t.name === "brain_moc_audit")).toBeDefined();
  });

  test("NOT in the writer-only scope", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((t) => t.name === "brain_moc_audit")).toBeUndefined();
  });
});

describe("brain_moc_audit round trip", () => {
  test("returns bucketed envelope for a qualifying hub", async () => {
    writePref("pref-a", { kind: "preference", topic: "a", status: "confirmed", principle: "p" });
    writePref("pref-b", { kind: "preference", topic: "b", status: "confirmed", principle: "p" });
    writePref("pref-c", { kind: "preference", topic: "c", status: "confirmed", principle: "p" });
    writePref("pref-d", { kind: "preference", topic: "d", status: "confirmed", principle: "p" });
    writePref("pref-e", { kind: "preference", topic: "e", status: "confirmed", principle: "p" });
    writePref(
      "pref-hub",
      { kind: "preference", topic: "hub", status: "confirmed", principle: "p" },
      "[[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]] [[pref-missing]]",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_moc_audit", { id: "pref-hub" });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["hub_id"]).toBe("pref-hub");
    expect(out["outbound_count"]).toBe(6);
    expect(
      (out["candidate_missing"] as Array<{ id: string }>).some(
        (c) => c.id === "pref-missing",
      ),
    ).toBe(true);
  });

  test("non-MOC hub returns INVALID_PARAMS", async () => {
    writePref(
      "pref-thin",
      { kind: "preference", topic: "t", status: "confirmed", principle: "p" },
      "Just [[pref-a]] and [[pref-b]] here.",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_moc_audit", { id: "pref-thin" });
    expect(r.error?.code).toBe(-32602);
  });
});

describe("brain_concept_synthesis registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((t) => t.name === "brain_concept_synthesis")).toBeDefined();
  });

  test("NOT in the writer-only scope", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((t) => t.name === "brain_concept_synthesis")).toBeUndefined();
  });
});

describe("brain_concept_synthesis round trip", () => {
  test("returns envelope with linkers", async () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subj",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "I see [[pref-tgt]] here.",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_concept_synthesis", {
      id: "pref-tgt",
    });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["target_id"]).toBe("pref-tgt");
    expect(out["target_title"]).toBe("Subj");
    expect(out["linkers"].length).toBe(1);
    expect(out["unlinked_mentions"]).toEqual([]);
  });

  test("include_unlinked=true populates unlinked_mentions", async () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject Line",
    });
    writePref(
      "pref-prose",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "Subject Line shows up here.",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_concept_synthesis", {
      id: "pref-tgt",
      include_unlinked: true,
    });
    const out = JSON.parse(r.result!.content[0]!.text);
    expect(out["unlinked_mentions"].length).toBe(1);
  });

  test("rejects empty id with INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_concept_synthesis", { id: "" });
    expect(r.error?.code).toBe(-32602);
  });

  test("rejects non-boolean include_unlinked", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callTool(server, "brain_concept_synthesis", {
      id: "pref-x",
      include_unlinked: "yes",
    });
    expect(r.error?.code).toBe(-32602);
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
