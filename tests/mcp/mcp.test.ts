import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return r;
}

async function callTool(server: MCPServer, name: string, args: Record<string, unknown> = {}, id = 99) {
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

  test("instructions embed resolved agent identity", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "agent_name: hermes-vps-agent\n");
    const server = new MCPServer({ vault, configPath: config });
    const r = (await initialize(server))! as any;
    const inst = r.result.instructions as string;
    expect(inst).toContain("@hermes-vps-agent");
    expect(inst).toContain("event_log_append");
    expect(inst).toContain("DO NOT");
  });

  test("negotiates alternate client version", async () => {
    const server = new MCPServer({ vault: tmp });
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old", version: "0" } },
    })) as any;
    expect(r.result.protocolVersion).toBe("2024-11-05");
  });

  test("notifications/initialized is silent (returns null)", async () => {
    const server = new MCPServer({ vault: tmp });
    expect(
      await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" }),
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
  test("advertises the core and Pay Memory tools", async () => {
    const server = new MCPServer({ vault: tmp });
    await initialize(server);
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/list",
    })) as any;
    const names = new Set(r.result.tools.map((t: { name: string }) => t.name));
    expect(names).toEqual(
      new Set([
        "second_brain_status",
        "second_brain_query",
        "second_brain_capture",
        "event_log_append",
        "vault_health",
        "payment_memory_init",
        "payment_receipt_append",
        "asset_capture",
        "payment_report_generate",
        "payment_policy_check",
        "payment_request_approval",
        "payment_request_status",
        "payment_request_consume",
      ]),
    );
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

  test("second_brain_query filters and limits", async () => {
    const vault = createSandboxVault(tmp);
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = (await callTool(server, "second_brain_query", { pattern: "Sandbox", limit: 5 })) as any;
    const s = r.result.structuredContent;
    expect(s.limit).toBe(5);
    expect(s.total_pages).toBeGreaterThanOrEqual(1);
    expect(s.pages.some((p: { title: string }) => p.title.includes("Sandbox"))).toBe(true);
  });

  test("second_brain_capture writes note with frontmatter", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = (await callTool(server, "second_brain_capture", {
      title: "Hello World",
      content: "# Body\n\ntext",
      tags: ["draft", "demo"],
    })) as any;
    const s = r.result.structuredContent;
    const note = join(vault, "AI Wiki", "notes", "hello-world.md");
    const text = readFileSync(note, "utf8");
    expect(text).toContain("title: Hello World");
    expect(text).toContain("tags: [draft, demo]");
    expect(text).toContain("# Body");
    expect(s.slug).toBe("hello-world");
  });

  test("second_brain_capture rejects existing note without overwrite", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const server = new MCPServer({ vault });
    await initialize(server);
    const args = { title: "Same Title", content: "first" };
    const first = (await callTool(server, "second_brain_capture", args)) as any;
    expect(first.result.isError).toBe(false);
    const second = (await callTool(server, "second_brain_capture", args, 100)) as any;
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0].text).toContain("already exists");
  });

  test("second_brain_capture rejects empty title", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = (await callTool(server, "second_brain_capture", {
      title: "   ",
      content: "body",
    })) as any;
    expect(r.error.code).toBe(-32602);
  });

  test("event_log_append writes daily note", async () => {
    const vault = tmp;
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = (await callTool(server, "event_log_append", {
      message: "via mcp",
      agent: "mcp-test",
      date: "2026.05.06",
      time: "11:42",
    })) as any;
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.agent).toBe("mcp-test");
    const daily = join(vault, "Daily", "2026.05.06.md");
    expect(readFileSync(daily, "utf8")).toContain("- 11:42 — @mcp-test — via mcp");
  });

  test("event_log_append strips leading @ in agent", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = (await callTool(server, "event_log_append", {
      message: "with-at-prefix",
      agent: "@hermes-vps-agent",
      date: "2026.05.06",
      time: "11:55",
    })) as any;
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.agent).toBe("hermes-vps-agent");
    const daily = join(vault, "Daily", "2026.05.06.md");
    const text = readFileSync(daily, "utf8");
    expect(text).toContain("- 11:55 — @hermes-vps-agent — with-at-prefix");
    expect(text).not.toContain("@@");
  });

  test("placeholder agent values fall back to default", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "agent_name: hermes-vps-agent\n");
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const cases = [
      "agent",
      "@agent",
      "AGENT",
      "  @agent  ",
      "assistant",
      "@assistant",
      "Assistant",
      "claude",
      "claude-code",
      "codex",
      "Codex",
      "@codex",
      "codex-cli",
      "codex-exec",
      "GPT",
      "gpt-5",
      "ai",
      "Bot",
      "model",
      "hermes",
      "openclaw",
    ];
    for (const trash of cases) {
      const r = (await callTool(server, "event_log_append", {
        message: `trash:${trash}`,
        agent: trash,
        date: "2026.05.06",
        time: "12:30",
      })) as any;
      expect(r.result.isError).toBe(false);
      expect(r.result.structuredContent.agent).toBe("hermes-vps-agent");
    }
  });

  test("empty optional strings treated as missing", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = (await callTool(server, "event_log_append", {
      message: "with-empty-optionals",
      agent: "",
      date: "",
      time: "",
    })) as any;
    expect(r.result.isError).toBe(false);
    const s = r.result.structuredContent;
    expect(s.date).toBeNull();
    expect(s.time).toBeNull();
  });

  test("uses configured timezone for daily file", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, 'agent_name: "hermes-vps-agent"\ntimezone: "Europe/Belgrade"\n');
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);

    // Capture local-tz wallclock BEFORE the call to avoid midnight rollover.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Belgrade",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const expectedDate = fmt.format(new Date()).replace(/-/g, ".");

    const r = (await callTool(server, "event_log_append", { message: "tz-test" })) as any;
    expect(r.result.isError).toBe(false);
    const expectedFile = join(vault, "Daily", `${expectedDate}.md`);
    const text = readFileSync(expectedFile, "utf8");
    expect(text).toContain("— @hermes-vps-agent — tz-test");
  });

  test("VAULT_TIMEZONE env wins over config", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, 'timezone: "UTC"\n');
    process.env["VAULT_TIMEZONE"] = "Europe/Belgrade";
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Belgrade",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const expectedDate = fmt.format(new Date()).replace(/-/g, ".");
    const r = (await callTool(server, "event_log_append", {
      message: "env-tz-test",
      agent: "tester",
    })) as any;
    expect(r.result.isError).toBe(false);
    const expectedFile = join(vault, "Daily", `${expectedDate}.md`);
    expect(() => readFileSync(expectedFile, "utf8")).not.toThrow();
  });

  test("invalid config timezone falls back silently", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, 'timezone: "Not/A/Real/Zone"\n');
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const r = (await callTool(server, "event_log_append", {
      message: "fallback",
      agent: "tester",
    })) as any;
    expect(r.result.isError).toBe(false);
  });

  test("uses agent_name from config when no env or arg", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "agent_name: openclaw-main\n");
    const server = new MCPServer({ vault, configPath: config });
    await initialize(server);
    const r = (await callTool(server, "event_log_append", {
      message: "from-config-default",
      date: "2026.05.06",
      time: "12:00",
    })) as any;
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent.agent).toBe("openclaw-main");
    const daily = join(vault, "Daily", "2026.05.06.md");
    expect(readFileSync(daily, "utf8")).toContain("- 12:00 — @openclaw-main — from-config-default");
  });

  test("event_log_append rejects invalid time", async () => {
    const server = new MCPServer({ vault: tmp });
    await initialize(server);
    const r = (await callTool(server, "event_log_append", {
      message: "x",
      time: "99:99",
    })) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("HH:MM");
  });

  test("event_log_append rejects invalid date paths", async () => {
    const server = new MCPServer({ vault: tmp });
    await initialize(server);
    const r = (await callTool(server, "event_log_append", {
      message: "x",
      date: "../AI Wiki/notes/pwn",
    })) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("YYYY.MM.DD");
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
});

describe("stdio loop", () => {
  test("processes initialize and tools/list", async () => {
    const server = new MCPServer({ vault: tmp });
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
        JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 2, method: "tools/list" }),
      ].join("\n") + "\n";
    const lines = await serveStdioFromString(server, payload);
    expect(lines.length).toBe(2);
    const init = JSON.parse(lines[0]!);
    const list = JSON.parse(lines[1]!);
    expect(init.id).toBe(1);
    expect(list.id).toBe(2);
    expect(list.result.tools.length).toBe(13);
  });

  test("returns parse error for invalid JSON", async () => {
    const server = new MCPServer({ vault: tmp });
    const lines = await serveStdioFromString(server, "{not json}\n");
    const r = JSON.parse(lines[0]!);
    expect(r.error.code).toBe(-32700);
  });

  test("returns invalid request for batch", async () => {
    const server = new MCPServer({ vault: tmp });
    const batch = JSON.stringify([
      { jsonrpc: JSONRPC_VERSION, id: 1, method: "ping" },
      { jsonrpc: JSONRPC_VERSION, id: 2, method: "ping" },
    ]);
    const lines = await serveStdioFromString(server, batch + "\n");
    const r = JSON.parse(lines[0]!);
    expect(r.error.code).toBe(-32600);
    expect(r.error.message.toLowerCase()).toContain("batch");
  });
});
