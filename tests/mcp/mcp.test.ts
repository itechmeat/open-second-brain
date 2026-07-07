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
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
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

  test("empty/non-ASCII inputs fall back to a stable unnamed-<hash>", () => {
    const fallback = /^unnamed-[0-9a-f]{8}$/;
    expect(slugify("   ")).toMatch(fallback);
    expect(slugify("---")).toMatch(fallback);
    expect(slugify("★ ☆ ☃")).toMatch(fallback);
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
  test("advertises the core and Brain tools (v0.10.8+)", async () => {
    const server = new MCPServer({ vault: tmp });
    await initialize(server);
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/list",
    })) as any;
    const names = r.result.tools.map((tool: { name: string }) => tool.name).toSorted();
    expect(names).toEqual(
      [
        // Runtime capability diagnostics (v0.23.0).
        "second_brain_capabilities",
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
        "brain_review_candidates",
        "brain_apply_evidence",
        "brain_note",
        // Brain Portability & Interop suite: write an actual vault note file.
        "brain_create_note",
        "brain_pinned_context",
        "brain_context",
        "brain_query",
        "brain_agent_query",
        "brain_agent_diff",
        "brain_doctor",
        "brain_health",
        "brain_hygiene",
        "brain_mcp_landscape",
        // Canonical entity registry read surface (Memory Integrity Suite).
        "brain_entity",
        "brain_backlinks",
        // Per-preference mutation audit + morning brief (added in v0.21.0).
        "brain_audit",
        // Vault portability suite (added in v0.22.0).
        "brain_sources",
        "brain_switch_vault",
        "brain_context_pack",
        "brain_context_pack_outcome",
        "brain_unlinked_mentions",
        "brain_moc_audit",
        "brain_stale_scan",
        // Pre-compress injection pack (added in v0.20.0).
        "brain_pre_compress_pack",
        // Context continuity and receipts (added in v0.29.0).
        "brain_context_receipts",
        "brain_event_trace",
        "brain_recall_telemetry",
        "brain_knowledge_gaps",
        "brain_context_presets",
        "brain_pre_compact_extract",
        "brain_session_grep",
        "brain_session_describe",
        "brain_session_expand",
        // Procedural-learning surfaces (v0.30.0).
        "brain_skill_proposals",
        "brain_procedural_memory",
        "brain_procedural_graph",
        "brain_recurrence",
        // Consolidated view tools (token-diet, v0.34.0); the per-view
        // names above stay registered as deprecated aliases.
        "brain_brief",
        "brain_analytics",
        "brain_anticipatory_context",
        // Search (added in v0.10.0; recall gate added in v0.27.0;
        // brain_search_expand added with progressive disclosure).
        "brain_recall_feedback",
        "brain_recall_gate",
        "brain_search",
        "brain_search_expand",
        "brain_eval",
        "brain_file_context",
        // Session Knowledge Synthesis Suite (v1.11.0).
        "brain_session_summary",
        "brain_idea_lineage",
        "brain_note_history",
        // Schema admin + watchdog recovery probes.
        "schema_apply_mutations",
        "schema_inspect",
        "brain_watchdog",
        // Agent Surface Suite: skill discovery + two-pass hydration.
        "list_skills",
        "get_skill",
        "skills_attach",
        "tool_hydrate",
        "brain_intention",
        // Workspace Insight Suite: trigger queue + proactive insight.
        "brain_trigger",
        "brain_deep_synthesis",
        "brain_idea_discovery",
        // Entity Truth & Self-Improving Dream Suite.
        "brain_truth",
        "brain_dead_ends",
        "brain_foresight",
        // Hindsight brain-loop ops: inbound, opt-in LLM generation tracing.
        "brain_generation_reports",
        // Write-Time Integrity & Governance Suite.
        "brain_labels",
        "brain_tiers",
        "brain_secrets",
        "brain_maintenance",
        // Link & Recall Intelligence Suite (v0.45.0).
        "brain_bridges",
        "brain_clusters",
        "brain_benchmark",
        "brain_tune",
        // CodeGraph & MCP Operational Readability (v1.12.0).
        "brain_codegraph_report",
        // Agent Write Contract Suite: provider-agnostic write sessions.
        "brain_write_session",
        // Knowledge Provenance Suite (v1.7.0).
        "brain_intake_entities",
        "brain_ingest_source",
        "brain_research_report",
        "brain_derive_fact",
        // Calendar integration: recurring obligations + agenda synthesis.
        "brain_obligation",
        "brain_agenda",
        // Hermes on_memory_write host bridge (memory-subsystem-alignment).
        "brain_memory_bridge",
        // Route-level MCP latency (context-pack-economics-observability).
        "brain_route_metrics",
        // Durable token-impact ledger (context-pack-economics-observability).
        "brain_token_impact",
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
    expect(s.vault.rules.some((r: { raw: string }) => r.raw === ".obsidian")).toBe(true);
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
    expect(s.pages.some((p: { title: string }) => p.title.includes("Sandbox"))).toBe(true);
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
    expect(r.result.content[0].text).toContain("bad_contract output contract failed");
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
    // tools added in v0.17.0) + 1 Search
    // + brain_artifact_get (v0.18.0) = 32.
    // + brain_mcp_landscape (typed graph semantics) = 33.
    // + brain_pre_compress_pack (v0.20.0) = 34.
    // + brain_audit (v0.21.0) = 35.
    // + brain_morning_brief (v0.21.0) = 36.
    // + brain_sources + brain_switch_vault (v0.22.0) = 38.
    // + second_brain_capabilities (v0.23.0) = 39.
    // + 9 schema admin tools + brain_watchdog = 49.
    // + brain_recall_gate (v0.27.0) = 50.
    // + 7 context continuity/session recall tools (v0.29.0) = 57.
    // + 3 procedural-learning tools (v0.30.0) = 60.
    // + brain_procedural_graph (v0.31.0) = 61.
    // + brain_attention_flows (v0.31.0) = 62.
    // + brain_recall_feedback (recall-trust-suite) = 63,
    // + brain_brief / brain_analytics / schema_inspect (token-diet) = 66
    // - 18 predecessors hidden as deprecated aliases (callable via
    //   tools/call, not advertised) = 48 (+1 capability diagnostic = 49).
    // + list_skills / get_skill / skills_attach / tool_hydrate /
    //   brain_intention (Agent Surface Suite) = 54.
    // + brain_trigger / brain_deep_synthesis / brain_idea_discovery
    //   (Workspace Insight Suite) = 57.
    // + brain_write_session (Agent Write Contract Suite) = 58.
    // + brain_truth / brain_dead_ends / brain_foresight
    //   (Entity Truth & Self-Improving Dream Suite) = 61.
    // + brain_labels / brain_tiers / brain_secrets / brain_maintenance
    //   (Write-Time Integrity & Governance Suite) = 65.
    // + brain_hygiene / brain_anticipatory_context
    //   (continuity-hygiene-freshness suite, v1.3.0) = 71.
    // + brain_eval (Search & Recall Quality Suite) = 72.
    // + brain_intake_entities / brain_ingest_source / brain_research_report
    //   / brain_derive_fact (Knowledge Provenance Suite, v1.7.0) = 76.
    // + brain_create_note (Brain Portability & Interop Suite) = 77.
    // + brain_file_context (Recall & Working-Memory Quality Suite) = 78.
    // + brain_session_summary / brain_idea_lineage / brain_note_history
    //   (Session Knowledge Synthesis Suite, v1.11.0) = 81.
    // + brain_codegraph_report (CodeGraph & MCP Operational Readability,
    //   v1.12.0) = 82.
    // + brain_generation_reports (Hindsight brain-loop ops) = 83.
    // + brain_obligation / brain_agenda (Calendar integration) = 85.
    // + brain_memory_bridge (Hermes on_memory_write host bridge,
    //   memory-subsystem-alignment) = 86.
    // + brain_event_trace (dashboard-context-trace: event→trace join) = 87.
    // + brain_search_expand (progressive disclosure: search→expand→transcript) = 88.
    // + brain_knowledge_gaps (cross-query demand log, t_97091fff) = 89.
    // + brain_route_metrics (route-level MCP latency, context-pack-economics-observability) = 90.
    // + brain_token_impact (durable token-impact ledger, context-pack-economics-observability) = 91.
    // + brain_context_pack_outcome (agent-operable outcome loop, context-pack-economics-observability) = 92.
    expect(list.result.tools.length).toBe(92);
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
    expect(text).not.toMatch(/brain_dream/);
  });
});
