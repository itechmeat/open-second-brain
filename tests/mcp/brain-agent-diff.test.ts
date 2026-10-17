import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-agent-diff-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-agent-diff-cfg-"));
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
  bootstrapBrain(vault, { configPath });
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
      clientInfo: { name: "agent-diff-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function call(server: MCPServer, name: string, args: Record<string, unknown>): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function seedVault(): void {
  writeSignal(vault, {
    topic: "shared-topic",
    signal: "positive",
    agent: "claude",
    principle: "Both agents know this topic.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "shared-claude",
  });
  writeSignal(vault, {
    topic: "shared-topic",
    signal: "positive",
    agent: "codex",
    principle: "Codex also knows this topic.",
    created_at: "2026-05-21T10:00:00Z",
    date: "2026-05-21",
    slug: "shared-codex",
  });
  writeSignal(vault, {
    topic: "codex-only",
    signal: "negative",
    agent: "codex",
    principle: "Do not hardcode agent pairs.",
    created_at: "2026-05-22T10:00:00Z",
    date: "2026-05-22",
    slug: "codex-only",
  });
}

describe("brain_agent_diff", () => {
  test("returns structured comparison results", async () => {
    seedVault();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const response = await call(server, "brain_agent_diff", {
      mode: "diff",
      agents: ["claude", "codex"],
    });

    expect(response.result.isError).toBe(false);
    const content = response.result.structuredContent;
    expect(content.mode).toBe("agent-diff");
    expect(content.diff_mode).toBe("diff");
    expect(content.shared_topics).toEqual(["shared-topic"]);
    expect(content.unique_topics).toEqual({
      claude: [],
      codex: ["codex-only"],
    });
  });
});

describe("brain_agent_diff cursor pagination", () => {
  test("the input schema declares a described cursor property", () => {
    const tool = buildToolTable("full").find((t) => t.name === "brain_agent_diff")!;
    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string; maxLength?: number; description?: string }>;
    };
    expect(schema.properties["cursor"]).toMatchObject({ type: "string", maxLength: 32 });
    expect(schema.properties["cursor"]?.description).toBeTruthy();
  });

  test("each page's next_cursor leads to the next and the pages reassemble the contributions", async () => {
    seedVault();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const total = 3;
    const limit = 2;
    // A server that never ends the walk would hang an unbounded loop;
    // ceil(total / limit) + 1 is one past the walk's own page count.
    const maxSteps = Math.ceil(total / limit) + 1;
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < maxSteps; step++) {
      const response = await call(server, "brain_agent_diff", {
        mode: "diff",
        agents: ["claude", "codex"],
        limit,
        ...(cursor !== null ? { cursor } : {}),
      });
      expect(response.result.isError).toBe(false);
      const content = response.result.structuredContent;
      expect(content.total_matched).toBe(total);
      // Aggregates are computed over the whole matched set, so they do
      // not move between pages.
      expect(content.shared_topics).toEqual(["shared-topic"]);
      // Guard the walk protocol: an ignored cursor would loop forever.
      expect(content.next_cursor === null || typeof content.next_cursor === "string").toBe(true);
      ids.push(...content.contributions.map((c: any) => c.id));
      cursor = content.next_cursor;
      if (cursor === null) break;
    }
    // The walk ended because the server exhausted the set, not because
    // the step bound fired.
    expect(cursor).toBeNull();
    expect(ids).toEqual([
      "sig-2026-05-20-shared-claude",
      "sig-2026-05-21-shared-codex",
      "sig-2026-05-22-codex-only",
    ]);
  });

  test("a malformed cursor is invalid params", async () => {
    seedVault();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = await call(server, "brain_agent_diff", {
      agents: ["claude"],
      cursor: "!!!",
    });
    expect(response.error?.code).toBe(-32602);
  });
});

describe("brain_agent_diff answer size semantics (M10)", () => {
  test("no limit returns the whole matched set with aggregates over it", async () => {
    seedVault();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = await call(server, "brain_agent_diff", {
      mode: "diff",
      agents: ["claude", "codex"],
    });
    const content = response.result.structuredContent;
    // The no-limit answer IS the whole matched set: one page, no cursor.
    expect(content.total_matched).toBe(3);
    expect(content.returned).toBe(3);
    expect(content.next_cursor).toBeNull();
    // The comparison covers the whole set: claude 1 contribution,
    // codex 2.
    const perAgent = new Map(
      (content.per_agent as ReadonlyArray<{ agent: string; contribution_count: number }>).map(
        (row) => [row.agent, row.contribution_count],
      ),
    );
    expect(perAgent.get("claude")).toBe(1);
    expect(perAgent.get("codex")).toBe(2);
  });

  test("limit bounds the returned contributions, never the comparison", async () => {
    seedVault();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = await call(server, "brain_agent_diff", {
      mode: "diff",
      agents: ["claude", "codex"],
      limit: 1,
    });
    const content = response.result.structuredContent;
    expect(content.total_matched).toBe(3);
    expect(content.returned).toBe(1);
    expect(content.next_cursor).not.toBeNull();
    // The aggregates still cover the whole matched set, exactly as the
    // schema text states.
    const perAgent = new Map(
      (content.per_agent as ReadonlyArray<{ agent: string; contribution_count: number }>).map(
        (row) => [row.agent, row.contribution_count],
      ),
    );
    expect(perAgent.get("codex")).toBe(2);
    expect(content.shared_topics).toEqual(["shared-topic"]);
  });
});
