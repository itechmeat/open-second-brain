import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import type { SessionTurn } from "../../src/core/brain/sessions/types.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-session-recall-"));
  const turns: SessionTurn[] = [
    {
      turnId: "t1",
      role: "user",
      timestamp: "2026-05-20T17:00:01.000Z",
      text: "Need receipt search.",
    },
    {
      turnId: "t2",
      role: "assistant",
      timestamp: "2026-05-20T17:00:02.000Z",
      text: "Receipt summary.",
    },
  ];
  importSessionRecall(vault, {
    sessionId: "session-mcp",
    turns,
    summaryGroupSize: 2,
    createdAt: "2026-05-20T17:00:00.000Z",
  });
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
      clientInfo: { name: "session-recall-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callOn(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  const parsed = JSON.parse(response.result.content[0]!.text) as Record<string, unknown>;
  // Session tools carry a preview budget (token-diet); when the result
  // came back as a preview envelope, fetch the full payload through
  // the same server's artifact store - exactly what a client does.
  if (parsed["preview_truncated"] === true) {
    const full = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 10,
      method: "tools/call",
      params: { name: "brain_artifact_get", arguments: { artifact_id: parsed["artifact_id"] } },
    })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
    const envelope = JSON.parse(full.result.content[0]!.text) as { content: string };
    return JSON.parse(envelope.content) as Record<string, unknown>;
  }
  return parsed;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath: null });
  await initialize(server);
  return await callOn(server, name, args);
}

describe("session recall MCP tool registration", () => {
  test("registered in the full tool table only", () => {
    for (const name of ["brain_session_grep", "brain_session_describe", "brain_session_expand"]) {
      expect(buildToolTable("full").find((tool) => tool.name === name)).toBeDefined();
      expect(buildToolTable("writer").find((tool) => tool.name === name)).toBeUndefined();
    }
  });
});

describe("session recall MCP tools", () => {
  test("grep, describe, and expand imported session recall records", async () => {
    const description = await callTool("brain_session_describe", {
      session_id: "session-mcp",
    });
    expect(description).toMatchObject({ raw_turns: 2, summary_nodes: 1 });

    const grep = await callTool("brain_session_grep", {
      query: "receipt",
      session_id: "session-mcp",
    });
    expect(
      (grep.hits as Array<{ kind: string }>).some((hit) => hit.kind === "session_summary_node"),
    ).toBe(true);

    const summary = (grep.hits as Array<{ id: string; kind: string }>).find(
      (hit) => hit.kind === "session_summary_node",
    )!;
    const expanded = await callTool("brain_session_expand", {
      id: summary.id,
      raw_limit: 1,
    });
    expect(expanded).toMatchObject({ next_cursor: "1" });
    expect(expanded.raw_content).toHaveLength(1);
  });

  test("since/before bound grep to a time window (S1)", async () => {
    // Both turns are at 2026-05-20T17:00:0Xz; a before-bound in the past
    // drops them, an enclosing window keeps them.
    const before = await callTool("brain_session_grep", {
      query: "receipt",
      session_id: "session-mcp",
      before: "2026-05-19",
    });
    expect((before.hits as Array<unknown>).length).toBe(0);

    const windowed = await callTool("brain_session_grep", {
      query: "receipt",
      session_id: "session-mcp",
      since: "2026-05-20",
      before: "2026-05-21",
    });
    expect(
      (windowed.hits as Array<{ kind: string }>).some((hit) => hit.kind === "session_turn"),
    ).toBe(true);
  });

  test("include_raw inlines raw captures and stamps extracted (C2)", async () => {
    const grep = await callTool("brain_session_grep", {
      query: "receipt",
      session_id: "session-mcp",
      include_raw: true,
    });
    const hits = grep.hits as Array<{
      kind: string;
      extracted: boolean;
      raw: Array<{ turn_id: string; text: string }>;
    }>;
    const summary = hits.find((hit) => hit.kind === "session_summary_node")!;
    expect(summary.extracted).toBe(true);
    expect(summary.raw.map((raw) => raw.turn_id)).toEqual(["t1", "t2"]);
    const turnHit = hits.find((hit) => hit.kind === "session_turn")!;
    expect(turnHit.extracted).toBe(false);
  });

  test("include_raw omitted is byte-identical (no extracted, no raw)", async () => {
    const grep = await callTool("brain_session_grep", {
      query: "receipt",
      session_id: "session-mcp",
    });
    for (const hit of grep.hits as Array<Record<string, unknown>>) {
      expect("extracted" in hit).toBe(false);
      expect("raw" in hit).toBe(false);
    }
  });

  test("an unparseable time bound rejects with an MCP error (S1)", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_session_grep",
        arguments: { query: "receipt", since: "not-a-date" },
      },
    })) as { error?: { message: string }; result?: { isError?: boolean } };
    // The invalid-input surfaces as an error (either JSON-RPC error or an
    // isError tool result), never a silently ignored filter.
    expect(response.error !== undefined || response.result?.isError === true).toBe(true);
  });
});

describe("brain_session_grep coverage operation (t_2c2a883c)", () => {
  test("coverage runs the thread selection end to end with diagnostics", async () => {
    const coverage = await callTool("brain_session_grep", {
      operation: "coverage",
      char_budget: 100_000,
      session_id: "session-mcp",
    });
    const turns = coverage.turns as Array<{ turn_id: string }>;
    expect(turns.map((turn) => turn.turn_id)).toEqual(["t1", "t2"]);
    const diagnostics = coverage.diagnostics as Record<string, unknown>;
    expect(diagnostics["facets_detected"]).toBe(1);
    expect(diagnostics["topics_requested"]).toBe(12);
    expect(diagnostics["topics_realized"]).toBe(1);
    expect(diagnostics["chars_used"]).toBeGreaterThan(0);
    expect(diagnostics["dropped_turn_ids"]).toEqual([]);
  });

  test("operation omitted stays byte-identical: hits only, no coverage fields", async () => {
    const grep = await callTool("brain_session_grep", {
      query: "receipt",
      session_id: "session-mcp",
    });
    expect("turns" in grep).toBe(false);
    expect("diagnostics" in grep).toBe(false);
    expect(Array.isArray(grep.hits)).toBe(true);
  });

  test("an unknown operation value is refused by name", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_session_grep",
        arguments: { operation: "widely" },
      },
    })) as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain("operation");
  });

  test("entity_key seeds the fan-out and an unknown key is refused by name", async () => {
    appendContinuityRecord(vault, {
      kind: "session_entity_mention",
      createdAt: "2026-05-20T17:00:03.000Z",
      sourceRefs: [{ id: "session-mcp:t1:symbol:ReceiptSearch" }],
      payload: {
        family: "symbol",
        key: "ReceiptSearch",
        session_ref: "session-mcp",
        turn_id: "t1",
      },
    });
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const call = (args: Record<string, unknown>) =>
      server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 9,
        method: "tools/call",
        params: { name: "brain_session_grep", arguments: args },
      }) as Promise<{
        error?: { code: number; message: string };
        result?: { content: ReadonlyArray<{ type: string; text: string }> };
      }>;

    const seeded = await call({
      operation: "coverage",
      char_budget: 100_000,
      entity_key: "ReceiptSearch",
    });
    const turns = JSON.parse(seeded.result!.content[0]!.text).turns as Array<{ turn_id: string }>;
    expect(turns.map((turn) => turn.turn_id)).toEqual(["t1", "t2"]);

    const unknown = await call({
      operation: "coverage",
      char_budget: 100_000,
      entity_key: "NoSuchEntity",
    });
    expect(unknown.error?.code).toBe(-32602);
    expect(unknown.error?.message).toContain("NoSuchEntity");

    for (const extra of [
      { since: "2026-05-01" },
      { before: "2026-05-21" },
      { limit: 5 },
      { snippet_chars: 40 },
    ]) {
      const refused = await call({ operation: "coverage", char_budget: 100_000, ...extra });
      expect(refused.error?.code).toBe(-32602);
    }

    // The coverage answer is one selection with no walk, so a well-formed
    // match-operation cursor must be refused by name, not silently
    // ignored (an ignored cursor would read as a page that happened).
    const cursor = await call({
      operation: "coverage",
      char_budget: 100_000,
      cursor: "bzow",
    });
    expect(cursor.error?.code).toBe(-32602);
    expect(cursor.error?.message).toContain("cursor is not applicable to operation 'coverage'");
  });

  test("entity_key accepts the mined-key length (200) and refuses longer", async () => {
    // Mined keys run to MINED_KEY_MAX_LENGTH = 200; a 129-200 character
    // URL or path key must be able to seed coverage over MCP, so the cap
    // matches the miner's, not the old 128.
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const call = (args: Record<string, unknown>) =>
      server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 9,
        method: "tools/call",
        params: { name: "brain_session_grep", arguments: args },
      }) as Promise<{ error?: { code: number; message: string } }>;

    const tooLong = await call({
      operation: "coverage",
      char_budget: 1000,
      entity_key: "K".repeat(201),
    });
    expect(tooLong.error?.code).toBe(-32602);
    expect(tooLong.error?.message).toContain("at most 200 characters");

    const atCap = await call({
      operation: "coverage",
      char_budget: 1000,
      entity_key: "K".repeat(200),
    });
    // A 200-character key is a legal mined key: the refusal is about the
    // unknown key, never about its length.
    expect(atCap.error?.code).toBe(-32602);
    expect(atCap.error?.message).toContain("no session_entity_mention row names");
  });

  test("coverage without char_budget is refused", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_session_grep",
        arguments: { operation: "coverage" },
      },
    })) as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain("char_budget");
  });

  test("coverage-only arguments are refused by name under the match operation", async () => {
    // The mirror of the refusal matrix above: char_budget and entity_key
    // name the coverage operation's knobs, so the default match operation
    // refuses them instead of silently ignoring them.
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const call = (args: Record<string, unknown>) =>
      server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 9,
        method: "tools/call",
        params: { name: "brain_session_grep", arguments: args },
      }) as Promise<{ error?: { code: number; message: string } }>;

    const budget = await call({ query: "receipt", char_budget: 100_000 });
    expect(budget.error?.code).toBe(-32602);
    expect(budget.error?.message).toContain("char_budget is not applicable to operation 'match'");

    const entity = await call({ query: "receipt", entity_key: "ReceiptSearch" });
    expect(entity.error?.code).toBe(-32602);
    expect(entity.error?.message).toContain(
      "entity_key is not applicable to operation 'match'; it seeds the coverage fan-out",
    );
  });

  test("the typed infeasibility error maps to INVALID_PARAMS", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_session_grep",
        arguments: { operation: "coverage", char_budget: 1, session_id: "session-mcp" },
      },
    })) as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain("required chars");
    expect(response.error?.message).toContain("floor-weighted");
  });

  test("describe renders the topic report when asked, and only then", async () => {
    const withTopics = await callTool("brain_session_describe", {
      session_id: "session-mcp",
      topics: true,
    });
    const report = withTopics.topic_report as Record<string, unknown>;
    expect(report["facets_detected"]).toBe(1);
    expect(report["topics_requested"]).toBe(12);
    expect(report["topics_realized"]).toBe(1);

    const withoutTopics = await callTool("brain_session_describe", {
      session_id: "session-mcp",
    });
    expect("topic_report" in withoutTopics).toBe(false);
  });
});

describe("brain_session_grep cursor pagination", () => {
  test("the input schema declares a described cursor property", () => {
    const tool = buildToolTable("full").find((t) => t.name === "brain_session_grep")!;
    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string; maxLength?: number; description?: string }>;
    };
    expect(schema.properties["cursor"]).toMatchObject({ type: "string", maxLength: 32 });
    expect(schema.properties["cursor"]?.description).toBeTruthy();
  });

  test("each page's next_cursor leads to the next and the pages reassemble the hits", async () => {
    const turns: SessionTurn[] = [
      {
        turnId: "w1",
        role: "user",
        timestamp: "2026-06-01T10:00:01.000Z",
        text: "walrus fact one",
      },
      {
        turnId: "w2",
        role: "assistant",
        timestamp: "2026-06-01T10:00:02.000Z",
        text: "walrus fact two",
      },
      {
        turnId: "w3",
        role: "user",
        timestamp: "2026-06-01T10:00:03.000Z",
        text: "walrus fact three",
      },
    ];
    importSessionRecall(vault, {
      sessionId: "session-walk",
      turns,
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);

    const full = await callOn(server, "brain_session_grep", {
      query: "walrus",
      session_id: "session-walk",
    });
    const allIds = (full["hits"] as ReadonlyArray<{ id: string }>).map((h) => h.id);
    expect(allIds.length).toBeGreaterThanOrEqual(3);

    // Bound the walk by the page arithmetic: ceil(total/limit) pages plus one
    // slack step, so a next_cursor that never turns null (an ignored or
    // never-exhausting cursor) exhausts the budget and fails here instead of
    // hanging the suite.
    const limit = 2;
    const maxSteps = Math.ceil(allIds.length / limit) + 1;
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < maxSteps; step += 1) {
      const page = await callOn(server, "brain_session_grep", {
        query: "walrus",
        session_id: "session-walk",
        limit,
        ...(cursor !== null ? { cursor } : {}),
      });
      expect(page["total"]).toBe(allIds.length);
      // Guard the walk protocol: an ignored cursor is a shape violation,
      // not a stop condition.
      const next = page["next_cursor"];
      expect(next === null || typeof next === "string").toBe(true);
      walked.push(...(page["hits"] as ReadonlyArray<{ id: string }>).map((h) => h.id));
      cursor = next as string | null;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(walked).toEqual(allIds);
  });

  test("a malformed cursor is refused as invalid params", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 30,
      method: "tools/call",
      params: {
        name: "brain_session_grep",
        arguments: { query: "x", cursor: "!!!" },
      },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32602);
  });
});

describe("brain_session_grep default answer size (M10)", () => {
  function importNeedleSession(target: string): void {
    const turns: SessionTurn[] = Array.from({ length: 14 }, (_, i) => ({
      turnId: `n${i + 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      timestamp: `2026-06-02T10:00:${String((i % 59) + 1).padStart(2, "0")}.000Z`,
      text: `needle fact ${i + 1}`,
    }));
    importSessionRecall(target, {
      sessionId: "session-needle",
      turns,
      createdAt: "2026-06-02T10:00:00.000Z",
    });
  }

  test("no limit returns the bounded default page, not every hit", async () => {
    importNeedleSession(vault);
    const payload = await callTool("brain_session_grep", {
      query: "needle",
      session_id: "session-needle",
    });
    // The historical bounded default (DEFAULT_LIMIT in session-recall.ts);
    // the pagination migration had defaulted the page to the whole set
    // (the match set spans the raw turns and the summary nodes distilled
    // from them).
    expect(payload["total"]).toBeGreaterThan(10);
    expect((payload["hits"] as ReadonlyArray<unknown>).length).toBe(10);
    expect(payload["next_cursor"]).not.toBeNull();
  });

  test("include_raw decorates the page's items and the walk still reassembles", async () => {
    importNeedleSession(vault);
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const first = await callOn(server, "brain_session_grep", {
      query: "needle",
      session_id: "session-needle",
      include_raw: true,
    });
    const hits = first["hits"] as ReadonlyArray<Record<string, unknown>>;
    expect(hits.length).toBe(10);
    for (const hit of hits) {
      // Every returned hit carries its inlined raw captures (C2) - the
      // decoration ran for the page, not for the whole match set.
      expect(hit["raw"]).toBeDefined();
      expect(hit["extracted"]).toBeDefined();
    }
    const cursor = first["next_cursor"];
    expect(typeof cursor).toBe("string");
    const second = await callOn(server, "brain_session_grep", {
      query: "needle",
      session_id: "session-needle",
      include_raw: true,
      cursor,
    });
    const rest = second["hits"] as ReadonlyArray<Record<string, unknown>>;
    expect(hits.length + rest.length).toBe(first["total"] as number);
    expect(second["next_cursor"]).toBeNull();
    for (const hit of rest) expect(hit["raw"]).toBeDefined();
  });
});
