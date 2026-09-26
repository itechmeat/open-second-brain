/**
 * `brain_session_expand` in payload mode (payload registry, t_35440e83).
 *
 * Paging returns the exact stored bytes, the cursor walks to the end,
 * and the transport reach decides what a caller may read: a local caller
 * reads any stored payload, a remote caller only one that a non-private
 * session turn references, directly or through another such payload -
 * never one named only by a private row, a page or the Brain log, and
 * never an orphan. Private rows themselves are withheld from the session
 * recall tools at remote reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../src/core/brain/continuity/store.ts";
import { payloadsDir } from "../../src/core/brain/paths.ts";
import { PayloadRegistry } from "../../src/core/brain/payload-registry.ts";
import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let vault: string;

const BLOB = "QUJD".repeat(500);
const OTHER_BLOB = "QkNE".repeat(300);

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-payload-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

interface ToolResponse {
  readonly result?: { content: ReadonlyArray<{ text: string }>; isError?: boolean };
  readonly error?: { code: number; message: string };
}

async function call(
  reach: TransportReach,
  args: Record<string, unknown>,
): Promise<{ body?: Record<string, unknown>; error?: { code: number; message: string } }> {
  return callTool(reach, "brain_session_expand", args);
}

async function callTool(
  reach: TransportReach,
  name: string,
  args: Record<string, unknown>,
): Promise<{ body?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const server = new MCPServer({ vault, configPath: null }, { reach });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "payload-expand-test", version: "0" },
    },
  });
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  })) as ToolResponse;
  if (response.error !== undefined) return { error: response.error };
  const text = response.result!.content[0]!.text;
  // A tool-level failure comes back as an error result carrying plain text.
  if (response.result!.isError === true) return { error: { code: 0, message: text } };
  return { body: JSON.parse(text) as Record<string, unknown> };
}

/** Import one turn; return the ref of the single payload it produced. */
function importTurn(sessionId: string, text: string): string {
  const before = new Set(safeList());
  importSessionRecall(vault, {
    sessionId,
    createdAt: "2026-09-20T10:00:00.000Z",
    turns: [{ turnId: "t1", role: "user", timestamp: "2026-09-20T10:00:01.000Z", text }],
  });
  const added = safeList().filter((name) => !before.has(name));
  expect(added).toHaveLength(1);
  return `osb-payload://${added[0]!.replace(/\.txt$/, "")}`;
}

function safeList(): string[] {
  try {
    return readdirSync(payloadsDir(vault));
  } catch {
    return [];
  }
}

describe("payload paging", () => {
  test("each page's next_cursor leads to the next, and the pages reassemble the exact bytes", async () => {
    const ref = importTurn("s-paging", `see ${BLOB}`);
    const cursors = ["0", "700", "1400"];
    const responses = await Promise.all(
      cursors.map((cursor) =>
        call(TRANSPORT_REACH.local, { payload: ref, cursor, payload_chars: 700 }),
      ),
    );
    const pages = responses.map((response) => ({
      page: response.body!["payload"] as { content: string; total_chars: number },
      next: response.body!["next_cursor"] as string | null,
    }));
    expect(pages.map((p) => p.next)).toEqual(["700", "1400", null]);
    for (const { page } of pages) expect(page.total_chars).toBe(BLOB.length);
    expect(pages.map((p) => p.page.content).join("")).toBe(BLOB);
  });

  test("malformed refs and mixed modes are invalid params", async () => {
    const traversal = await call(TRANSPORT_REACH.local, {
      payload: "osb-payload://../../etc/passwd",
    });
    expect(traversal.error?.code).toBe(-32602);
    const ref = importTurn("s-mixed", BLOB);
    const mixed = await call(TRANSPORT_REACH.local, { payload: ref, id: "ctn_x" });
    expect(mixed.error?.code).toBe(-32602);
  });
});

describe("payload reach", () => {
  test("a payload referenced from an ordinary session row is readable remotely", async () => {
    const ref = importTurn("s-shared", BLOB);
    const { body, error } = await call(TRANSPORT_REACH.remote, {
      payload: ref,
      payload_chars: 400,
    });
    expect(error).toBeUndefined();
    expect((body!["payload"] as { content: string }).content).toBe(BLOB.slice(0, 400));
  });

  test("a payload reachable only through a private session row is refused remotely", async () => {
    const ref = importTurn("s-private", `<private>internal</private> ${BLOB}`);
    expect((await call(TRANSPORT_REACH.remote, { payload: ref })).error?.code).toBe(-32602);
    expect((await call(TRANSPORT_REACH.local, { payload: ref })).body).toBeDefined();
  });

  test("a payload named only by a page, or by nothing, is refused remotely", async () => {
    const registry = new PayloadRegistry({ vault, maxInlineChars: 10 });
    const reserved = registry.externalizeOversized(OTHER_BLOB).payloads[0]!.ref;
    writeFileSync(join(vault, "secret.md"), `---\nvisibility: private\n---\n\nSee ${reserved}\n`);
    const orphan = registry.externalizeOversized(BLOB).payloads[0]!.ref;

    const refs = [reserved, orphan];
    const remote = await Promise.all(
      refs.map((ref) => call(TRANSPORT_REACH.remote, { payload: ref })),
    );
    for (const response of remote) {
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain("not readable at remote reach");
    }
    const local = await Promise.all(
      refs.map((ref) => call(TRANSPORT_REACH.local, { payload: ref, payload_chars: 100 })),
    );
    for (const response of local) expect(response.body).toBeDefined();

    // A page without the reserved token grants nothing either: pages are
    // written by tools a session turn is not.
    writeFileSync(join(vault, "secret.md"), `See ${reserved}\n`);
    expect((await call(TRANSPORT_REACH.remote, { payload: reserved })).error?.code).toBe(-32602);
  });

  test("a ref recorded through brain_note does not open a private turn's payload", async () => {
    const ref = importTurn("s-note", `<private>internal</private> ${BLOB}`);
    const noted = await callTool(TRANSPORT_REACH.local, "brain_note", {
      text: `pointer ${ref}`,
    });
    expect(noted.error).toBeUndefined();
    const logDir = join(vault, "Brain", "log");
    expect(
      readdirSync(logDir).some(
        (name) => name.endsWith(".md") && readFileSync(join(logDir, name), "utf8").includes(ref),
      ),
    ).toBe(true);
    expect((await call(TRANSPORT_REACH.remote, { payload: ref })).error?.code).toBe(-32602);
    expect((await call(TRANSPORT_REACH.local, { payload: ref })).body).toBeDefined();
  });

  test("a payload chained from a remotely readable payload is readable remotely", async () => {
    const registry = new PayloadRegistry({ vault, maxInlineChars: 10 });
    const inner = registry.externalizeOversized(OTHER_BLOB).payloads[0]!.ref;
    const outer = importTurn("s-chain", `${"word ".repeat(10)}${inner}${" pad".repeat(9000)}`);
    expect((await call(TRANSPORT_REACH.remote, { payload: outer })).error).toBeUndefined();
    expect((await call(TRANSPORT_REACH.remote, { payload: inner })).error).toBeUndefined();
  });
});

describe("private session rows at remote reach", () => {
  function importPrivateTurn(): string {
    importSessionRecall(vault, {
      sessionId: "s-hidden",
      createdAt: "2026-09-20T10:00:00.000Z",
      turns: [
        {
          turnId: "t1",
          role: "user",
          timestamp: "2026-09-20T10:00:01.000Z",
          text: `<private>internal</private> needle ${BLOB}`,
        },
      ],
    });
    const row = listContinuityRecords(vault).find((r) => r.kind === "session_turn")!;
    expect(row.private).toBe(true);
    return row.id;
  }

  test("brain_session_expand answers a private row like an absent one", async () => {
    const id = importPrivateTurn();
    const hidden = await callTool(TRANSPORT_REACH.remote, "brain_session_expand", { id });
    const absent = await callTool(TRANSPORT_REACH.remote, "brain_session_expand", {
      id: "ctn_does_not_exist",
    });
    expect(hidden.error?.code).toBe(absent.error?.code);
    expect(hidden.error?.message.replace(id, "<id>")).toBe(
      absent.error?.message.replace("ctn_does_not_exist", "<id>"),
    );
    const local = await callTool(TRANSPORT_REACH.local, "brain_session_expand", { id });
    expect(local.error).toBeUndefined();
  });

  test("brain_session_grep and brain_session_describe leave it out remotely only", async () => {
    importPrivateTurn();
    const remoteGrep = await callTool(TRANSPORT_REACH.remote, "brain_session_grep", {
      query: "needle",
    });
    expect((remoteGrep.body!["hits"] as unknown[]).length).toBe(0);
    const localGrep = await callTool(TRANSPORT_REACH.local, "brain_session_grep", {
      query: "needle",
    });
    expect((localGrep.body!["hits"] as unknown[]).length).toBeGreaterThan(0);

    const remoteDescribe = await callTool(TRANSPORT_REACH.remote, "brain_session_describe", {
      session_id: "s-hidden",
    });
    expect(remoteDescribe.body!["raw_turns"]).toBe(0);
    const localDescribe = await callTool(TRANSPORT_REACH.local, "brain_session_describe", {
      session_id: "s-hidden",
    });
    expect(localDescribe.body!["raw_turns"]).toBe(1);
  });
});
