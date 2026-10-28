import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { emitObservedUse } from "../../src/core/brain/observed-use.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

/** A plain vault page at a vault-relative path, frontmatter and all. */
function writePage(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-context-receipts-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-context-receipts-cfg-"));
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
      clientInfo: { name: "context-receipts-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callReceipts(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context_receipts", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_context_receipts tool registration", () => {
  test("registered in the full tool table", () => {
    const tools = buildToolTable("full");
    expect(tools.find((tool) => tool.name === "brain_context_receipts")).toBeDefined();
  });

  test("not registered in the writer-only tool table", () => {
    const tools = buildToolTable("writer");
    expect(tools.find((tool) => tool.name === "brain_context_receipts")).toBeUndefined();
  });
});

describe("brain_context_receipts tool", () => {
  test("lists summaries and shows a full receipt by id", async () => {
    const receipt = emitContextReceipt(vault, {
      options: {
        host: "mcp-test",
        trigger: "pre_compress",
        createdAt: "2026-05-20T14:00:00.000Z",
        sessionId: "session-mcp",
      },
      finalText: "pre-compress pack text",
      items: [{ id: "pref-alpha", text: "Prefer crisp answers" }],
    });
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const list = await callReceipts(server, {
      operation: "list",
      trigger: "pre_compress",
    });
    expect(list["total"]).toBe(1);
    expect((list["receipts"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: receipt.id,
      trigger: "pre_compress",
      host: "mcp-test",
      item_count: 1,
    });

    const show = await callReceipts(server, {
      operation: "show",
      id: receipt.id,
    });
    expect(show["id"]).toBe(receipt.id);
    expect((show["payload"] as Record<string, unknown>)["session_id"]).toBe("session-mcp");
  });

  test("show joins the session's reply_presence record and names unjoined honestly", async () => {
    // The pages the hook recorded: readable and unreserved, so the join
    // keeps their rows at the default (below-local) reach too.
    writePage("Brain/preferences/pref-alpha.md", "Public body.\n");
    writePage("Brain/preferences/pref-bravo.md", "Public body.\n");
    const joined = emitContextReceipt(vault, {
      options: {
        host: "mcp-test",
        trigger: "session_inject",
        createdAt: "2026-05-20T14:00:00.000Z",
        sessionId: "session-present",
      },
      finalText: "eager layer",
      items: [{ id: "pref-alpha", path: "Brain/preferences/pref-alpha.md" }],
    });
    const lonely = emitContextReceipt(vault, {
      options: {
        host: "mcp-test",
        trigger: "session_inject",
        createdAt: "2026-05-20T14:05:00.000Z",
        sessionId: "session-absent",
      },
      finalText: "eager layer",
      items: [{ id: "pref-bravo", path: "Brain/preferences/pref-bravo.md" }],
    });
    const presence = appendContinuityRecord(vault, {
      kind: "reply_presence",
      createdAt: "2026-05-20T14:10:00.000Z",
      payload: {
        session_id: "session-present",
        checked: 1,
        per_note: [
          { path: "Brain/preferences/pref-alpha.md", start_line: 2, verdict: "not-in-note" },
        ],
      },
    });
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const showJoined = await callReceipts(server, { operation: "show", id: joined.id });
    expect(showJoined["reply_presence"]).toEqual({
      joined: true,
      presence: {
        record_id: presence.id,
        created_at: "2026-05-20T14:10:00.000Z",
        checked: 1,
        per_note: [
          { path: "Brain/preferences/pref-alpha.md", start_line: 2, verdict: "not-in-note" },
        ],
      },
    });

    // No reply_presence record for this receipt's session: the outcome is
    // NAMED on the response, never a silent absence.
    const showLonely = await callReceipts(server, { operation: "show", id: lonely.id });
    expect(showLonely["reply_presence"]).toEqual({
      joined: false,
      reason: "unjoined",
      session_id: "session-absent",
    });

    // The list summaries stay summaries: no per-row presence join.
    const list = await callReceipts(server, { operation: "list", trigger: "session_inject" });
    for (const entry of list["receipts"] as Array<Record<string, unknown>>) {
      expect("reply_presence" in entry).toBe(false);
    }
  });

  test("a note verified in the next turn reads verified through show, whatever later turns did", async () => {
    // The review's timeline, through the tool surface: the Stop hook
    // writes a record on every checked turn, including later turns that
    // quote nothing, so the receipt's join must fold its own lifetime -
    // a later all-absent turn never erases an earlier verification, and
    // the row list stays the receipt's own injection.
    writePage("Brain/notes/note-a.md", "Note a body.\n");
    writePage("Brain/notes/note-b.md", "Note b body.\n");
    const receipt = emitContextReceipt(vault, {
      options: {
        host: "mcp-test",
        trigger: "session_inject",
        createdAt: "2026-05-20T15:00:00.000Z",
        sessionId: "session-fold",
      },
      finalText: "eager layer",
      items: [{ id: "note-a", path: "Brain/notes/note-a.md" }],
    });
    appendContinuityRecord(vault, {
      kind: "reply_presence",
      createdAt: "2026-05-20T15:01:00.000Z",
      payload: {
        session_id: "session-fold",
        checked: 1,
        per_note: [
          { path: "Brain/notes/note-a.md", start_line: 1, end_line: 1, verdict: "verified" },
        ],
      },
    });
    const last = appendContinuityRecord(vault, {
      kind: "reply_presence",
      createdAt: "2026-05-20T15:06:00.000Z",
      payload: {
        session_id: "session-fold",
        checked: 0,
        per_note: [
          { path: "Brain/notes/note-a.md", verdict: "absent" },
          { path: "Brain/notes/note-b.md", verdict: "absent" },
        ],
      },
    });
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const show = await callReceipts(server, { operation: "show", id: receipt.id });
    expect(show["reply_presence"]).toEqual({
      joined: true,
      presence: {
        record_id: last.id,
        created_at: "2026-05-20T15:06:00.000Z",
        checked: 1,
        per_note: [
          { path: "Brain/notes/note-a.md", start_line: 1, end_line: 1, verdict: "verified" },
        ],
      },
    });
  });

  test("below local reach the join withholds a reserved page's row and counts the withholding", async () => {
    writePage("Brain/preferences/pref-open.md", "Open body.\n");
    writePage(
      "Brain/preferences/pref-reserved.md",
      "---\nvisibility: private\n---\n\nReserved body.\n",
    );
    const receipt = emitContextReceipt(vault, {
      options: {
        host: "mcp-test",
        trigger: "session_inject",
        createdAt: "2026-05-20T14:00:00.000Z",
        sessionId: "session-withheld-page",
      },
      finalText: "eager layer",
      items: [
        { id: "pref-open", path: "Brain/preferences/pref-open.md" },
        { id: "pref-reserved", path: "Brain/preferences/pref-reserved.md" },
      ],
    });
    appendContinuityRecord(vault, {
      kind: "reply_presence",
      createdAt: "2026-05-20T14:10:00.000Z",
      payload: {
        session_id: "session-withheld-page",
        checked: 2,
        per_note: [
          { path: "Brain/preferences/pref-open.md", verdict: "verified" },
          {
            path: "Brain/preferences/pref-reserved.md",
            start_line: 3,
            end_line: 5,
            verdict: "verified",
          },
        ],
      },
    });

    // A caller that established nothing answers at the narrowest reach:
    // the reserved page's path, range and verdict are gone, and the join
    // says it withheld one row rather than reading as an absent note.
    const remote = new MCPServer({ vault, configPath });
    await initialize(remote);
    const below = await callReceipts(remote, { operation: "show", id: receipt.id });
    expect(below["reply_presence"]).toEqual({
      joined: true,
      presence: {
        record_id: expect.any(String),
        created_at: "2026-05-20T14:10:00.000Z",
        checked: 2,
        per_note: [{ path: "Brain/preferences/pref-open.md", verdict: "verified" }],
        withheld: 1,
      },
    });
    // The JOIN carries no trace of the withheld page - not its path, not
    // its line range, not its verdict. (The receipt's own items are the
    // record of what was injected; this pin is the join's.)
    expect(JSON.stringify(below["reply_presence"])).not.toContain("pref-reserved");

    // At local reach the operator still sees every row, and no withholding.
    const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
    await initialize(local);
    const above = await callReceipts(local, { operation: "show", id: receipt.id });
    expect(above["reply_presence"]).toEqual({
      joined: true,
      presence: {
        record_id: expect.any(String),
        created_at: "2026-05-20T14:10:00.000Z",
        checked: 2,
        per_note: [
          { path: "Brain/preferences/pref-open.md", verdict: "verified" },
          {
            path: "Brain/preferences/pref-reserved.md",
            start_line: 3,
            end_line: 5,
            verdict: "verified",
          },
        ],
      },
    });
  });

  test("summary folds a session and joins the observed-use verdicts", async () => {
    for (const [createdAt, tokens] of [
      ["2026-05-21T14:00:00.000Z", 10],
      ["2026-05-21T14:05:00.000Z", 14],
    ] as const) {
      emitContextReceipt(vault, {
        options: {
          host: "mcp-test",
          trigger: "context_pack",
          createdAt,
          sessionId: "session-fold",
        },
        finalText: "pack",
        items: [{ id: "pref-alpha", path: "Brain/preferences/pref-alpha.md", tokens }],
      });
    }
    emitObservedUse(vault, {
      createdAt: "2026-05-21T14:10:00.000Z",
      host: "mcp-test",
      sessionId: "session-fold",
      entries: [{ id: "pref-alpha", path: "Brain/preferences/pref-alpha.md", verdict: "USED" }],
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const summary = await callReceipts(server, {
      operation: "summary",
      session_id: "session-fold",
    });
    expect(summary["recorded"]).toBe(true);
    expect(summary["receipt_count"]).toBe(2);
    expect(summary["distinct_items"]).toBe(1);
    expect(summary["item_total"]).toBe(2);
    expect(summary["truncated"]).toBe(false);
    const items = summary["items"] as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      id: "pref-alpha",
      injections: 2,
      tokens: 24,
      observed: { used: 1, ignored: 0, contradicted: 0, total: 1 },
    });
  });

  test("summary over a vault with no receipts says so instead of returning zeros", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const summary = await callReceipts(server, { operation: "summary" });
    expect(summary["recorded"]).toBe(false);
    expect(summary["receipt_count"]).toBeUndefined();
    expect(summary["items"]).toBeUndefined();
    expect(typeof summary["note"]).toBe("string");
  });

  test("a malformed window bound is INVALID_PARAMS, never an empty window", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    emitContextReceipt(vault, {
      options: {
        host: "unit",
        trigger: "context_pack",
        createdAt: "2026-06-01T10:00:00Z",
        sessionId: "s1",
      },
      items: [{ id: "pref-a", tokens: 1 }],
      finalText: "x",
    });
    const summarize = async (
      args: Record<string, unknown>,
    ): Promise<{ error?: { code: number; message: string } }> =>
      (await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 12,
        method: "tools/call",
        params: { name: "brain_context_receipts", arguments: { operation: "summary", ...args } },
      })) as { error?: { code: number; message: string } };

    // Before this, "yesterday" sorted after every stored timestamp and
    // the tool answered `recorded: false, note: "no receipts recorded
    // for this filter"` - a finding about the vault, for a typo.
    const [word, offset] = await Promise.all([
      summarize({ since: "yesterday" }),
      summarize({ until: "2026-06-01T10:00:00+03:00" }),
    ]);
    expect(word.error?.message).toContain("canonical UTC");
    expect(offset.error?.message).toContain("canonical UTC");
  });

  test("summary counts the receipts that carried nothing", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    emitContextReceipt(vault, {
      options: {
        host: "hook",
        trigger: "session_inject",
        createdAt: "2026-06-01T10:00:00Z",
        sessionId: "s2",
      },
      items: [],
      finalText: "degraded-to-cache injection",
    });
    const summary = await callReceipts(server, { operation: "summary", session_id: "s2" });
    expect(summary["receipt_count"]).toBe(1);
    expect(summary["item_total"]).toBe(0);
    expect(summary["empty_receipts"]).toBe(1);
    expect(summary["malformed_receipts"]).toBe(0);
  });

  test("an unknown operation names every branch", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 11,
      method: "tools/call",
      params: { name: "brain_context_receipts", arguments: { operation: "nope" } },
    })) as { error?: { message: string }; result?: { content: ReadonlyArray<{ text: string }> } };
    const text = response.error?.message ?? response.result?.content[0]?.text ?? "";
    expect(text).toContain("summary");
  });
});

describe("brain_context_receipts cursor pagination", () => {
  test("operation=list declares a described, length-capped cursor property", () => {
    const tool = buildToolTable("full").find((t) => t.name === "brain_context_receipts")!;
    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string; maxLength?: number; description?: string }>;
    };
    expect(schema.properties["cursor"]).toMatchObject({ type: "string", maxLength: 32 });
    expect(schema.properties["cursor"]?.description).toBeTruthy();
  });

  test("each page's next_cursor leads to the next and the pages reassemble every receipt", async () => {
    const ids: string[] = [];
    for (const [index, createdAt] of [
      "2026-05-20T14:00:00.000Z",
      "2026-05-20T14:05:00.000Z",
      "2026-05-20T14:10:00.000Z",
    ].entries()) {
      ids.push(
        emitContextReceipt(vault, {
          options: {
            host: "mcp-test",
            trigger: "context_pack",
            createdAt,
            sessionId: "session-walk",
          },
          finalText: "pack",
          items: [{ id: `pref-${index}`, text: "Prefer crisp answers" }],
        }).id,
      );
    }
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    // Bound the walk by the page arithmetic: ceil(total/limit) pages plus one
    // slack step, so a next_cursor that never turns null (an ignored or
    // never-exhausting cursor) exhausts the budget and fails here instead of
    // hanging the suite.
    const total = 3;
    const limit = 2;
    const maxSteps = Math.ceil(total / limit) + 1;
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < maxSteps; step += 1) {
      const list = await callReceipts(server, {
        operation: "list",
        session_id: "session-walk",
        limit,
        ...(cursor !== null ? { cursor } : {}),
      });
      expect(list["total"]).toBe(total);
      // Guard the walk protocol: an ignored cursor is a shape violation,
      // not a stop condition.
      const next = list["next_cursor"];
      expect(next === null || typeof next === "string").toBe(true);
      walked.push(
        ...(list["receipts"] as ReadonlyArray<Record<string, unknown>>).map(
          (r) => r["id"] as string,
        ),
      );
      cursor = next as string | null;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(walked.toSorted()).toEqual(ids.toSorted());
    expect(new Set(walked).size).toBe(3);
  });

  test("a malformed cursor is refused as invalid params", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 12,
      method: "tools/call",
      params: {
        name: "brain_context_receipts",
        arguments: { operation: "list", cursor: "!!!" },
      },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32602);
  });
});
