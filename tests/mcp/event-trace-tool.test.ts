import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-event-trace-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-event-trace-cfg-"));
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
      clientInfo: { name: "event-trace-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function callEventTrace(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_event_trace", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_event_trace tool registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((tool) => tool.name === "brain_event_trace")).toBeDefined();
  });

  test("not registered in the writer-only tool table", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((tool) => tool.name === "brain_event_trace")).toBeUndefined();
  });
});

describe("brain_event_trace tool", () => {
  test("joins continuity records to a logged event by session id", async () => {
    appendLogEvent(vault, {
      timestamp: "2026-06-15T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.writeSession,
      agent: "tester",
      body: { session_id: "sess-1", kind: "note", status: "committed" },
    });
    const want = appendContinuityRecord(vault, {
      kind: "recall_telemetry",
      createdAt: "2026-06-15T10:00:05Z",
      sourceRefs: [],
      payload: { session_id: "sess-1", mode: "context_pack", status: "ok" },
    }).id;

    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const result = await callEventTrace(server, { date: "2026-06-15" });
    expect(result["total"]).toBe(1);
    expect(result["trace_total"]).toBe(1);
    const events = result["events"] as Array<Record<string, unknown>>;
    const traces = events[0]!["traces"] as Array<Record<string, unknown>>;
    expect(traces[0]!["id"]).toBe(want);
    expect(traces[0]!["joinedBy"]).toEqual(["session"]);
  });

  test("rejects an unknown event kind", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: { name: "brain_event_trace", arguments: { kind: "not-a-kind" } },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32602);
  });

  test("a runtime IO error surfaces as INTERNAL_ERROR, not INVALID_PARAMS", async () => {
    // Brain/log exists but is a FILE: existsSync passes, readdirSync throws
    // ENOTDIR inside the resolver's IO path. A bad selector is a caller error
    // (-32602); a runtime IO failure must be an internal error (-32603).
    rmSync(join(vault, "Brain", "log"), { recursive: true, force: true });
    writeFileSync(join(vault, "Brain", "log"), "not a directory\n");
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: { name: "brain_event_trace", arguments: { date: "2026-06-15" } },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32603);
  });

  test("an event naming a page outside the vault is withheld at remote reach", async () => {
    writeFileSync(join(tmp, "outside.md"), "---\ntitle: beside the vault\n---\nbody\n");
    appendLogEvent(vault, {
      timestamp: "2026-06-15T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.note,
      agent: "tester",
      body: { text: "../outside.md" },
    });

    const remote = new MCPServer({ vault, configPath });
    await initialize(remote);
    const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
    await initialize(local);

    expect((await callEventTrace(remote, { date: "2026-06-15" }))["total"]).toBe(0);
    expect((await callEventTrace(local, { date: "2026-06-15" }))["total"]).toBe(1);
  });
});

describe("brain_event_trace cursor pagination", () => {
  test("the input schema declares a described cursor property declares a described cursor property", () => {
    const tool = buildToolTable("full").find((t) => t.name === "brain_event_trace")!;
    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string; maxLength?: number; description?: string }>;
    };
    expect(schema.properties["cursor"]).toMatchObject({ type: "string", maxLength: 32 });
    expect(schema.properties["cursor"]?.description).toBeTruthy();
  });

  test("each page's next_cursor leads to the next and the pages reassemble every event", async () => {
    for (const [index, stamp] of ["10:00:00", "10:05:00", "10:10:00"].entries()) {
      appendLogEvent(vault, {
        timestamp: `2026-06-15T${stamp}Z`,
        eventType: BRAIN_LOG_EVENT_KIND.writeSession,
        agent: "tester",
        body: { session_id: `sess-walk-${index}`, kind: "note", status: "committed" },
      });
    }
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const total = 3;
    const limit = 2;
    // A server that never ends the walk would hang an unbounded loop;
    // ceil(total / limit) + 1 is one past the walk's own page count.
    const maxSteps = Math.ceil(total / limit) + 1;
    const stamps: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < maxSteps; step++) {
      const page = await callEventTrace(server, {
        date: "2026-06-15",
        limit,
        ...(cursor !== null ? { cursor } : {}),
      });
      expect(page["total"]).toBe(total);
      // Guard the walk protocol: an ignored cursor would loop forever.
      const next = page["next_cursor"];
      expect(next === null || typeof next === "string").toBe(true);
      stamps.push(
        ...(page["events"] as ReadonlyArray<Record<string, unknown>>).map(
          (e) => (e["event"] as Record<string, unknown>)["timestamp"] as string,
        ),
      );
      cursor = next as string | null;
      if (cursor === null) break;
    }
    // The walk ended because the server exhausted the set, not because
    // the step bound fired.
    expect(cursor).toBeNull();
    expect(stamps).toHaveLength(3);
    expect(new Set(stamps).size).toBe(3);
  });

  test("a malformed cursor is refused as invalid params", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 12,
      method: "tools/call",
      params: {
        name: "brain_event_trace",
        arguments: { date: "2026-06-15", cursor: "!!!" },
      },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32602);
  });

  test("a page fetch's scan stops at the page's lookahead bound and the walk still reassembles every event", async () => {
    for (let index = 0; index < 8; index++) {
      appendLogEvent(vault, {
        timestamp: `2026-06-15T10:${String(index * 5).padStart(2, "0")}:00Z`,
        eventType: BRAIN_LOG_EVENT_KIND.writeSession,
        agent: "tester",
        body: { session_id: `sess-bound-${index}`, kind: "note", status: "committed" },
      });
    }
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    // Eight events sit far past one page's reach, so page 1's `total`
    // tells whether the trace-attachment scan walked the whole day
    // (total 8) or stopped at the page's own reach (the
    // offset + limit + 1 lookahead bound).
    const first = await callEventTrace(server, { date: "2026-06-15", limit: 3 });
    expect(first["total"]).toBe(4);
    expect(first["next_cursor"]).not.toBeNull();

    // The bound buys the page, never truncation: walking still
    // reassembles all eight events, and the exhausted walk's total is
    // exact. The residual walk is bounded by the whole walk's own page
    // arithmetic so a never-null cursor fails fast instead of hanging.
    const seeded = 8;
    const walkLimit = 3;
    const maxSteps = Math.ceil(seeded / walkLimit) + 1;
    const stamps: string[] = (first["events"] as ReadonlyArray<Record<string, unknown>>).map(
      (e) => (e["event"] as Record<string, unknown>)["timestamp"] as string,
    );
    let cursor = first["next_cursor"] as string | null;
    let lastTotal = first["total"];
    for (let step = 0; step < maxSteps && cursor !== null; step++) {
      const page = await callEventTrace(server, {
        date: "2026-06-15",
        limit: walkLimit,
        cursor,
      });
      stamps.push(
        ...(page["events"] as ReadonlyArray<Record<string, unknown>>).map(
          (e) => (e["event"] as Record<string, unknown>)["timestamp"] as string,
        ),
      );
      lastTotal = page["total"];
      cursor = page["next_cursor"] as string | null;
    }
    expect(cursor).toBeNull();
    expect(lastTotal).toBe(8);
    expect(stamps).toHaveLength(8);
    expect(new Set(stamps).size).toBe(8);
  });
});
