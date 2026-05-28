import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  serveStdioFromString,
  slugify,
} from "../../src/mcp/index.ts";
import { createPluginRepo, createSandboxVault } from "../helpers/fixtures.ts";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-test-"));
  for (const k of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function initialize(server: MCPServer) {
  const r = await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
  return r;
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown> = {},
  id = 99,
) {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

describe("slugify (re-exported via MCP barrel)", () => {
  test("lowercases and replaces punctuation", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  test("handles empty/non-ASCII inputs", () => {
    expect(slugify("   ")).toBe("note");
    expect(slugify("---")).toBe("note");
    expect(slugify("★ ☆ ☃")).toBe("note");
  });

  test("truncates to 64 chars", () => {
    expect(slugify("a".repeat(200)).length).toBe(64);
  });
});

describe("handshake", () => {
  test("initialize returns server info and tools capability", async () => {
    const server = new MCPServer({ vault: tmp });
    const r = (await initialize(server))!;
    expect(r.jsonrpc).toBe(JSONRPC_VERSION);
    expect(r.id).toBe(1);
    const result = (r as any).result;
    expect(result.serverInfo.name).toBe(SERVER_NAME);
    expect(result.serverInfo.version).toBe(SERVER_VERSION);
    expect(result.capabilities.tools).toBeDefined();
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test("instructions embed resolved agent identity and Brain tools", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "agent_name: hermes-vps-agent\n");
    const server = new MCPServer({ vault, configPath: config });
    const r = (await initialize(server))! as any;
    const inst = r.result.instructions as string;
    expect(inst).toContain("@hermes-vps-agent");
    // v0.9.0+ — instructions advertise Brain tools, not the legacy
    // `second_brain_capture` path. v0.10.8 instructions may mention
    // `event_log_append` once, only as the historical name of the
    // retired tool that `brain_note` now replaces — they must NOT
    // teach the agent to call it.
    expect(inst).toContain("brain_feedback");
    expect(inst).toContain("brain_apply_evidence");
    expect(inst).toContain("brain_note");
    expect(inst).not.toContain("second_brain_capture");
    // Allowed mention is the "retired" reference; reject any wording
    // that frames `event_log_append` as an active tool to call.
    expect(inst).not.toMatch(/call\s+`?event_log_append`?/i);
    expect(inst).not.toMatch(/use\s+`?event_log_append`?/i);
  });

  test("negotiates alternate client version", async () => {
    const server = new MCPServer({ vault: tmp });
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "old", version: "0" },
      },
    })) as any;
    expect(r.result.protocolVersion).toBe("2024-11-05");
  });

  test("notifications/initialized is silent (returns null)", async () => {
    const server = new MCPServer({ vault: tmp });
    expect(
      await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        method: "notifications/initialized",
      }),
    ).toBeNull();
  });

  test("unknown method returns method-not-found", async () => {
    const server = new MCPServer({ vault: tmp });
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 7,
      method: "does/not/exist",
    })) as any;
    expect(r.error.code).toBe(-32601);
  });
});

describe("tool listing", () => {
  test("advertises the core, Brain, and Pay Memory tools (v0.10.8+)", async () => {
    const server = new MCPServer({ vault: tmp });
    await initialize(server);
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/list",
    })) as any;
    const names = r.result.tools
      .map((tool: { name: string }) => tool.name)
      .toSorted();
    expect(names).toEqual(
      [
        // Core read/health (writable legacy tools removed in v0.9.0).
        "second_brain_status",
        "second_brain_query",
        "vault_health",
        // Preview-budget artifact fetch (added in v0.18.0).
        "brain_artifact_get",
        // Brain (brain_note added in v0.10.8 §32B,
        // brain_context added in v0.10.10,
        // brain_context_pack added in v0.10.15,
        // brain_operator_summary added in v0.10.16,
        // brain_unlinked_mentions / brain_concept_synthesis /
        // brain_moc_audit added in v0.10.17,
        // brain_timeline / brain_belief_evolution / brain_stale_scan /
        // brain_daily_brief / brain_weekly_synthesis added in v0.10.18,
        // brain_agent_query / brain_agent_diff added in v0.15.0,
        // lifecycle review tools added in v0.17.0.
        "brain_feedback",
        "brain_dream",
        "brain_intent_review",
        "brain_retention",
        "brain_monthly_review",
        "brain_review_candidates",
        "brain_apply_evidence",
        "brain_note",
        "brain_pinned_context",
        "brain_context",
        "brain_digest",
        "brain_query",
        "brain_agent_query",
        "brain_agent_diff",
        "brain_doctor",
        "brain_health",
        "brain_mcp_landscape",
        "brain_backlinks",
        "brain_context_pack",
        "brain_unlinked_mentions",
        "brain_concept_synthesis",
        "brain_moc_audit",
        "brain_timeline",
        "brain_belief_evolution",
        "brain_stale_scan",
        "brain_daily_brief",
        "brain_weekly_synthesis",
        "brain_operator_summary",
        // Pay Memory (unchanged).
        "payment_memory_init",
        "payment_receipt_append",
        "asset_capture",
        "payment_report_generate",
        "payment_policy_check",
        "payment_request_approval",
        "payment_request_status",
        "payment_request_consume",
        // Search (added in v0.10.0).
        "brain_search",
      ].toSorted(),
    );
    // Explicit grep: legacy writable tools are no longer advertised.
    expect(names.includes("event_log_append")).toBe(false);
    expect(names.includes("second_brain_capture")).toBe(false);
    for (const t of r.result.tools) {
      expect(t.inputSchema.type).toBe("object");
    }
  });
});

describe("tool calls", () => {
  test("second_brain_status reports vault and config", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "vault_path: /tmp/vault\napi_key: secret\n");
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const r = (await callTool(server, "second_brain_status"))! as any;
    const s = r.result.structuredContent;
    expect(s.vault_path).toBe(vault);
    expect(s.vault_exists).toBe(true);
    expect(s.config.api_key).toBe("[REDACTED]");
    expect(s.config_keys).toContain("vault_path");
  });

  test("second_brain_status includes a `brain` section with counts and activity", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "vault_path: /tmp/vault\n");
    // Brain layer absent → `brain.present` is `false` with zero counts.
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const r = (await callTool(server, "second_brain_status"))! as any;
    const s = r.result.structuredContent;
    expect(s.brain).toBeDefined();
    expect(s.brain.present).toBe(false);
    expect(s.brain.counts.preferences).toBe(0);
    expect(s.brain.last_dream_at).toBeNull();
    expect(s.brain.sanity.signals_awaiting_dream).toBe(0);
  });

  test("second_brain_status includes a `vault` block (v0.10.9)", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    mkdirSync(join(vault, ".obsidian"));
    writeFileSync(join(vault, ".obsidian", "app.json"), "{}");
    writeFileSync(join(vault, "note.md"), "# x\n");
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "vault_path: /tmp/vault\n");
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const r = (await callTool(server, "second_brain_status"))! as any;
    const s = r.result.structuredContent;
    expect(s.vault).toBeDefined();
    expect(s.vault.ignore_source).toBeDefined();
    expect(["_brain.yaml", "defaults"]).toContain(s.vault.ignore_source);
    expect(Array.isArray(s.vault.rules)).toBe(true);
    expect(
      s.vault.rules.some((r: { raw: string }) => r.raw === ".obsidian"),
    ).toBe(true);
    expect(typeof s.vault.included.files).toBe("number");
    expect(typeof s.vault.included.dirs).toBe("number");
    expect(typeof s.vault.excluded.dirs).toBe("number");
    expect(typeof s.vault.excluded.files).toBe("number");
    expect(s.vault.excluded.dirs).toBeGreaterThanOrEqual(1);
  });

  test("second_brain_status omits `vault` block when vault directory missing", async () => {
    const vault = join(tmp, "missing-vault");
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "vault_path: /tmp/vault\n");
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const r = (await callTool(server, "second_brain_status"))! as any;
    const s = r.result.structuredContent;
    expect(s.vault_exists).toBe(false);
    expect(s.vault).toBeUndefined();
  });

  test("second_brain_status degrades vault block to {error} when _brain.yaml is malformed (v0.10.9)", async () => {
    // Fail-closed resolver (design §5) makes walkers and the CLI
    // vault verb refuse to proceed on a malformed config. The MCP
    // status tool is a read-only diagnostic — it should still
    // expose the other blocks (brain / search / config) so the
    // operator can see what is wrong without losing the rest.
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    mkdirSync(join(vault, "Brain"));
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      // entry contains a backslash → rejected by validator.
      `schema_version: 1\nvault:\n  ignore_paths:\n    - "bad\\\\entry"\n`,
    );
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "vault_path: /tmp/vault\n");
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const r = (await callTool(server, "second_brain_status"))! as any;
    const s = r.result.structuredContent;
    // Other blocks must remain present.
    expect(s.config_path).toBeDefined();
    expect(s.vault_exists).toBe(true);
    expect(s.brain).toBeDefined();
    // Vault block degraded with the error message.
    expect(s.vault).toBeDefined();
    expect(typeof s.vault.error).toBe("string");
    expect(s.vault.error).toContain("vault.ignore_paths");
  });

  test("second_brain_query filters and limits", async () => {
    const vault = createSandboxVault(tmp);
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = (await callTool(server, "second_brain_query", {
      pattern: "Sandbox",
      limit: 5,
    })) as any;
    const s = r.result.structuredContent;
    expect(s.limit).toBe(5);
    expect(s.total_pages).toBeGreaterThanOrEqual(1);
    expect(
      s.pages.some((p: { title: string }) => p.title.includes("Sandbox")),
    ).toBe(true);
  });

  // `second_brain_capture` and `event_log_append` are no longer
  // advertised through MCP in v0.9.0 (design doc §11.1). The handler
  // functions remain in `src/mcp/tools.ts` for shell-side use
  // (`o2b append-event`); their behaviour is covered by the CLI / core
  // event-log tests. Here we only assert that the tool registry no
  // longer exposes them.
  test("removed legacy writable tools return method-not-found", async () => {
    const server = new MCPServer({ vault: tmp });
    await initialize(server);
    for (const name of ["second_brain_capture", "event_log_append"]) {
      const r = (await callTool(server, name, {
        title: "x",
        content: "y",
        message: "z",
      })) as any;
      expect(r.error.code).toBe(-32601);
    }
  });

  test("vault_health runs doctor", async () => {
    const vault = createSandboxVault(tmp);
    const repo = createPluginRepo(tmp, true);
    const server = new MCPServer({ vault, repoRoot: repo });
    await initialize(server);
    const r = (await callTool(server, "vault_health", {})) as any;
    const s = r.result.structuredContent;
    expect(s.ok).toBe(true);
    const names = new Set(s.checks.map((c: { name: string }) => c.name));
    expect(names.has("vault_writeable")).toBe(true);
    expect(names.has("claude_manifest")).toBe(true);
    expect(names.has("hermes_manifest")).toBe(true);
  });

  test("unknown tool returns method-not-found", async () => {
    const server = new MCPServer({ vault: tmp });
    await initialize(server);
    const r = (await callTool(server, "not_a_tool")) as any;
    expect(r.error.code).toBe(-32601);
  });

  test("tool output contract failure becomes a tool-level error", async () => {
    const server = new MCPServer({ vault: tmp });
    await initialize(server);
    (server as any).tools = [
      {
        name: "bad_contract",
        description: "test tool",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
          additionalProperties: false,
        },
        handler: () => ({ ok: "yes" }),
      },
    ];
    const r = (await callTool(server, "bad_contract")) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.structuredContent).toBeUndefined();
    expect(r.result.content[0].text).toContain(
      "bad_contract output contract failed",
    );
  });
});

describe("stdio loop", () => {
  test("processes initialize and tools/list", async () => {
    const payload =
      [
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          method: "notifications/initialized",
        }),
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: 2,
          method: "tools/list",
        }),
      ].join("\n") + "\n";
    const out = await serveStdioFromString({ vault: tmp }, payload);
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(2);
    const init = JSON.parse(lines[0]!);
    const list = JSON.parse(lines[1]!);
    expect(init.id).toBe(1);
    expect(list.id).toBe(2);
    // v0.17.0: 3 core + 27 Brain (brain_health added in v0.14.0
    // Semantic Brain Health; brain_review_candidates added in v0.12.0
    // Brain Integrity Suite; brain_timeline / brain_belief_evolution /
    // brain_stale_scan / brain_daily_brief / brain_weekly_synthesis
    // added v0.10.18; brain_agent_query / brain_agent_diff added in
    // v0.15.0; brain_pinned_context added in v0.16.0; lifecycle review
    // tools added in v0.17.0) + 8 Pay Memory + 1 Search
    // + brain_artifact_get (v0.18.0) = 40.
    // + brain_mcp_landscape (typed graph semantics) = 41.
    expect(list.result.tools.length).toBe(41);
  });

  test("returns parse error for invalid JSON", async () => {
    const out = await serveStdioFromString({ vault: tmp }, "{not json}\n");
    const r = JSON.parse(out.trim());
    expect(r.error.code).toBe(-32700);
  });

  test("returns invalid request for batch", async () => {
    const batch = JSON.stringify([
      { jsonrpc: JSONRPC_VERSION, id: 1, method: "ping" },
      { jsonrpc: JSONRPC_VERSION, id: 2, method: "ping" },
    ]);
    const out = await serveStdioFromString({ vault: tmp }, batch + "\n");
    const r = JSON.parse(out.trim());
    expect(r.error.code).toBe(-32600);
    expect(r.error.message.toLowerCase()).toContain("batch");
  });
});

describe("MCPServer serverName override", () => {
  test("default ctor uses SERVER_NAME constant", async () => {
    const server = new MCPServer({ vault: tmp });
    const r = (await initialize(server))! as any;
    expect(r.result.serverInfo.name).toBe("open-second-brain");
  });

  test("explicit serverName flows into initialize response", async () => {
    const server = new MCPServer(
      { vault: tmp, configPath: null, repoRoot: null },
      { serverName: "open-second-brain-writer" },
    );
    const r = (await initialize(server))! as any;
    expect(r.result.serverInfo.name).toBe("open-second-brain-writer");
  });
});

describe("serveStdioFromString respects scope+name", () => {
  test("writer scope filters tools/list response", async () => {
    const ctx = { vault: "/tmp/x", configPath: null, repoRoot: null };
    const initReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    const listReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const out = await serveStdioFromString(ctx, `${initReq}\n${listReq}\n`, {
      scope: "writer",
      serverName: "open-second-brain-writer",
    });
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].result.serverInfo.name).toBe("open-second-brain-writer");
    const toolNames = (lines[1].result.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .toSorted();
    expect(toolNames).toEqual([
      "brain_apply_evidence",
      "brain_context",
      "brain_feedback",
      "brain_note",
      "brain_pinned_context",
    ]);
  });
});

import { buildInstructions } from "../../src/mcp/instructions.ts";

describe("buildInstructions writer mode", () => {
  test("writer instructions name both tools and point at the full server", () => {
    const text = buildInstructions({
      vault: "/tmp/x",
      agent: "@agent",
      scope: "writer",
    });
    expect(text).toContain("brain_feedback");
    expect(text).toContain("brain_apply_evidence");
    expect(text).toContain("open-second-brain"); // points at sibling server
    expect(text).not.toMatch(/payment_/i);
    expect(text).not.toMatch(/brain_dream/);
  });
});
