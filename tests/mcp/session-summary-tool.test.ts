import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-summary-tool-"));
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
      clientInfo: { name: "session-summary-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function call(args: Record<string, unknown>): Promise<{ result?: unknown; error?: unknown }> {
  const server = new MCPServer({ vault, configPath: null });
  await initialize(server);
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_session_summary", arguments: args },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("brain_session_summary tool", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_session_summary"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_session_summary"),
    ).toBeUndefined();
  });

  test("write then get round-trips the digest", async () => {
    const written = payload(
      await call({
        operation: "write",
        session_id: "s1",
        request: "Build the digest",
        decisions: ["reuse continuity store"],
        learnings: ["node != digest"],
        next_steps: ["ship the tool"],
      }),
    );
    expect(written["written"]).toBe(true);

    const got = payload(await call({ operation: "get", session_id: "s1" }));
    expect(got["found"]).toBe(true);
    const digest = got["digest"] as Record<string, unknown>;
    expect(digest["session_id"]).toBe("s1");
    expect(digest["decisions"]).toEqual(["reuse continuity store"]);
    expect(digest["next_steps"]).toEqual(["ship the tool"]);
  });

  test("get for an unknown session reports not found, not a fabricated digest", async () => {
    const got = payload(await call({ operation: "get", session_id: "missing" }));
    expect(got["found"]).toBe(false);
    expect(got["digest"]).toBeUndefined();
  });

  test("write with no categories is an invalid-params error", async () => {
    const response = await call({ operation: "write", session_id: "empty" });
    expect(response.error).toBeDefined();
    expect((response.error as { code: number }).code).toBe(-32602);
  });

  test("bad operation is an invalid-params error", async () => {
    const response = await call({ operation: "frobnicate", session_id: "x" });
    expect(response.error).toBeDefined();
    expect((response.error as { code: number }).code).toBe(-32602);
  });

  test("list returns digests scoped to a session", async () => {
    await call({ operation: "write", session_id: "a", decisions: ["da"] });
    await call({ operation: "write", session_id: "b", decisions: ["db"] });
    const all = payload(await call({ operation: "list" }));
    expect(all["count"]).toBe(2);
    const scoped = payload(await call({ operation: "list", session_id: "a" }));
    expect(scoped["count"]).toBe(1);
    expect((scoped["digests"] as Array<Record<string, unknown>>)[0]!["session_id"]).toBe("a");
  });
});

describe("brain_session_summary project scope (Task 18)", () => {
  test("write carries the normalized project and list filters by it", async () => {
    const written = payload(
      await call({
        operation: "write",
        session_id: "p1",
        project_scope: "Open Second/Brain -- v2!",
        decisions: ["scoped"],
      }),
    );
    expect(written["written"]).toBe(true);
    expect((written["digest"] as Record<string, unknown>)["project"]).toBe("open-second-brain-v2");

    await call({ operation: "write", session_id: "p2", decisions: ["unscoped"] });

    const all = payload(await call({ operation: "list" }));
    expect(all["count"]).toBe(2);
    const scoped = payload(
      await call({ operation: "list", project_scope: "OPEN SECOND BRAIN V2" }),
    );
    expect(scoped["count"]).toBe(1);
    expect((scoped["digests"] as Array<Record<string, unknown>>)[0]!["session_id"]).toBe("p1");
  });

  test("a digest written with no project omits the field entirely", async () => {
    const written = payload(
      await call({ operation: "write", session_id: "plain", decisions: ["d"] }),
    );
    const digest = written["digest"] as Record<string, unknown>;
    expect("project" in digest).toBe(false);
  });

  test("a malformed project is an invalid-params error naming the argument", async () => {
    const response = await call({
      operation: "write",
      session_id: "bad",
      project_scope: "***",
      decisions: ["d"],
    });
    expect(response.error).toBeDefined();
    const error = response.error as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toMatch(/project/);
  });

  test("a non-string project is an invalid-params error", async () => {
    const response = await call({
      operation: "write",
      session_id: "bad2",
      project_scope: 42,
      decisions: ["d"],
    });
    expect((response.error as { code: number }).code).toBe(-32602);
  });

  test("the tool advertises project_scope, matching the brain_search filter name", () => {
    const tool = buildToolTable("full").find((entry) => entry.name === "brain_session_summary");
    const properties = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(properties["project_scope"]).toBeDefined();
  });
});
