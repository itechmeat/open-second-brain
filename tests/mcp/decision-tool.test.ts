import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-decision-tool-"));
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
      clientInfo: { name: "decision-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_decision", arguments: args },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("brain_decision tool", () => {
  test("registered in the full tool table", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_decision")).toBeDefined();
  });

  test("records a decision and reads it back with its outcome", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const recorded = payload(
      await call(server, {
        action: "record",
        title: "Adopt Bun runtime",
        chosen: "Bun",
        assumption: "Bun stays compatible",
        review_date: "2026-12-01",
      }),
    );
    expect(recorded["id"]).toBe("decision-adopt-bun-runtime");
    expect(recorded["obligation_created"]).toBe(true);

    const outcome = payload(
      await call(server, { action: "outcome", slug: "adopt-bun-runtime", outcome: "held up" }),
    );
    expect(outcome["outcome"]).toBe("held up");

    const shown = payload(await call(server, { action: "show", slug: "adopt-bun-runtime" }));
    expect(shown["outcome"]).toBe("held up");
  });

  test("similar surfaces a prior decision", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, {
      action: "record",
      title: "Adopt Bun runtime for CLI",
      chosen: "Bun",
      assumption: "x",
      review_date: "2026-12-01",
    });
    const similar = payload(
      await call(server, {
        action: "similar",
        title: "Adopt Bun runtime for server",
        chosen: "Bun",
      }),
    );
    expect((similar["similar"] as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  test("rate, list rated, and compare (B2)", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, {
      action: "record",
      title: "Option A",
      chosen: "A",
      assumption: "x",
      review_date: "2026-12-01",
      rating: 4,
    });
    await call(server, {
      action: "record",
      title: "Option B",
      chosen: "B",
      assumption: "y",
      review_date: "2026-12-01",
    });
    const rated = payload(await call(server, { action: "rate", slug: "option-b", rating: 5 }));
    expect(rated["rating"]).toBe(5);

    const list = payload(await call(server, { action: "list", rated: true }));
    const decisions = list["decisions"] as Array<{ rating: number }>;
    expect(decisions.map((d) => d.rating)).toEqual([5, 4]);

    const compared = payload(
      await call(server, { action: "compare", slugs: ["option-a", "option-b"] }),
    );
    expect((compared["decisions"] as unknown[]).length).toBe(2);
  });

  test("out-of-range rating returns an error", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    await call(server, {
      action: "record",
      title: "Option C",
      chosen: "C",
      assumption: "z",
      review_date: "2026-12-01",
    });
    const res = await call(server, { action: "rate", slug: "option-c", rating: 9 });
    expect(res.error).toBeDefined();
  });

  test("malformed input returns an error result", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const res = await call(server, {
      action: "record",
      title: "x",
      chosen: "y",
      assumption: "z",
      review_date: "not-a-date",
    });
    expect(res.error).toBeDefined();
  });
});
