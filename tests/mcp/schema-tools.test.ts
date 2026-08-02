import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { INVALID_PARAMS } from "../../src/mcp/protocol.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

/**
 * Epoch seconds stamped onto `Brain/_brain.yaml` before a dry run, far
 * enough in the past that any write during the preview would move the
 * modification time to now rather than leaving it within a coarse
 * filesystem timestamp of where it started.
 */
const PAST_MTIME_SECONDS = Date.UTC(2020, 0, 1) / 1000;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-schema-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
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
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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
      clientInfo: { name: "schema-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function call(
  server: MCPServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function makeServer(): MCPServer {
  return new MCPServer({ vault, configPath });
}

describe("schema MCP tools", () => {
  test("registers the schema administration surface", async () => {
    const server = makeServer();
    await initialize(server);

    const response = await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 50,
      method: "tools/list",
    });
    const names = ((response as any).result.tools as ReadonlyArray<{ name: string }>).map(
      (tool) => tool.name,
    );

    // token-diet consolidated the per-view readers into schema_inspect;
    // the 1.0.0 sweep removed the hidden aliases entirely.
    expect(names).toContain("schema_inspect");
    expect(names).toContain("schema_apply_mutations");
    expect(names).not.toContain("schema_stats");
  });

  test("applies schema mutations through the MCP handler", async () => {
    const server = makeServer();
    await initialize(server);

    const applied = await call(server, "schema_apply_mutations", {
      mutations: [{ op: "add_type", category: "preference_types", token: "decision" }],
    });
    expect((applied as any).result.structuredContent.applied).toBe(1);

    const pack = await call(server, "schema_inspect", { view: "active_pack" });
    expect((pack as any).result.structuredContent.pack.declarations.preference_types).toContain(
      "decision",
    );
  });

  test("schema graph namespaces link type node ids", async () => {
    const server = makeServer();
    await initialize(server);

    await call(server, "schema_apply_mutations", {
      mutations: [
        { op: "add_type", category: "preference_types", token: "decision" },
        { op: "add_link_type", token: "decision" },
      ],
    });
    const graph = await call(server, "schema_inspect", { view: "graph" });
    const nodes = (graph as any).result.structuredContent.nodes as ReadonlyArray<{ id: string }>;

    expect(nodes.map((node) => node.id)).toContain("decision");
    expect(nodes.map((node) => node.id)).toContain("link:decision");
  });

  test("dry_run previews the resulting pack and its diff without touching _brain.yaml", async () => {
    const server = makeServer();
    await initialize(server);
    const brainConfig = join(vault, "Brain", "_brain.yaml");
    utimesSync(brainConfig, PAST_MTIME_SECONDS, PAST_MTIME_SECONDS);
    // Base64 so the later comparison is over raw bytes, not decoded text.
    const bytesBefore = readFileSync(brainConfig).toString("base64");
    const mtimeBefore = statSync(brainConfig).mtimeMs;

    const preview = await call(server, "schema_apply_mutations", {
      mutations: [{ op: "add_type", category: "preference_types", token: "decision" }],
      dry_run: true,
    });

    const structured = (preview as any).result.structuredContent;
    expect(structured.dry_run).toBe(true);
    expect(structured.would_apply).toBe(1);
    expect(structured.pack.declarations.preference_types).toContain("decision");
    expect(structured.diff).toEqual([
      { path: "declarations.preference_types", before: null, after: "decision" },
    ]);
    // A preview must never look like an apply: no audit record was written,
    // so there is no audit path to report.
    expect(structured.audit_path).toBeUndefined();

    expect(readFileSync(brainConfig).toString("base64")).toBe(bytesBefore);
    expect(statSync(brainConfig).mtimeMs).toBe(mtimeBefore);
    const pack = await call(server, "schema_inspect", { view: "active_pack" });
    expect(
      (pack as any).result.structuredContent.pack.declarations.preference_types ?? [],
    ).not.toContain("decision");
  });

  test("an apply with no dry_run argument behaves exactly as today", async () => {
    const server = makeServer();
    await initialize(server);

    const applied = await call(server, "schema_apply_mutations", {
      mutations: [{ op: "add_type", category: "preference_types", token: "decision" }],
    });

    const structured = (applied as any).result.structuredContent;
    expect(structured.applied).toBe(1);
    expect(typeof structured.audit_path).toBe("string");
    expect(structured.pack.declarations.preference_types).toContain("decision");
    // The dry-run key exists only on a preview; an apply carries neither it
    // nor the diff, exactly as before dry_run was added.
    expect("dry_run" in structured).toBe(false);
    expect("diff" in structured).toBe(false);

    const pack = await call(server, "schema_inspect", { view: "active_pack" });
    expect((pack as any).result.structuredContent.pack.declarations.preference_types).toContain(
      "decision",
    );
  });

  test("a rejected preview returns the same error envelope the apply returns", async () => {
    const server = makeServer();
    await initialize(server);
    const rejected = [{ op: "add_prefix", prefix: "pref", token: "undeclared" }];

    const preview = await call(server, "schema_apply_mutations", {
      mutations: rejected,
      dry_run: true,
    });
    const apply = await call(server, "schema_apply_mutations", { mutations: rejected });

    expect((preview as any).result.isError).toBe(true);
    expect((preview as any).result.content[0].text).toBe(
      "schema.prefixes.pref: token is not declared",
    );
    expect((preview as any).result).toEqual((apply as any).result);
  });

  test("a non-boolean dry_run is an invalid param", async () => {
    const server = makeServer();
    await initialize(server);

    const response = await call(server, "schema_apply_mutations", {
      mutations: [{ op: "add_type", category: "preference_types", token: "decision" }],
      dry_run: "yes",
    });

    expect((response as any).error.code).toBe(INVALID_PARAMS);
    expect((response as any).error.message).toContain("dry_run");
  });

  test("schema apply reports coercion failures as invalid params", async () => {
    const server = makeServer();
    await initialize(server);

    const response = await call(server, "schema_apply_mutations", {
      mutations: "not an array",
    });

    expect((response as any).error.code).toBe(INVALID_PARAMS);
    expect((response as any).error.message).toContain("mutations must be an array");
  });
});
