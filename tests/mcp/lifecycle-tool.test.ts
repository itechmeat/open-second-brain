/**
 * Tests for the `brain_lifecycle` MCP tool's temporal-replace action
 * (Belief lifecycle suite, A2, t_3ba9c404).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { parseFrontmatter, writeFrontmatter } from "../../src/core/vault.ts";

let vault: string;
const AT = "2026-07-18T12:00:00Z";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-lifecycle-tool-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
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
      clientInfo: { name: "lifecycle-test", version: "0" },
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
    params: { name: "brain_lifecycle", arguments: args },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

function writeFact(slug: string): string {
  const rel = join("Brain", "preferences", `pref-${slug}.md`);
  writeFrontmatter(
    join(vault, rel),
    {
      kind: "brain-preference",
      id: `pref-${slug}`,
      _status: "confirmed",
      topic: slug,
      principle: `fact ${slug}`,
    },
    "Prose.",
  );
  return rel;
}

describe("brain_lifecycle temporal-replace", () => {
  test("closes predecessor and opens successor at a shared instant", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const pred = writeFact("old");
    const succ = writeFact("new");
    const res = payload(
      await call(server, {
        action: "temporal-replace",
        predecessor: pred,
        successor: succ,
        at: AT,
      }),
    );
    expect(res["action"]).toBe("temporal-replace");
    expect(res["at"]).toBe(AT);
    expect(res["predecessor"]).toBe("Brain/preferences/pref-old.md");
    expect(res["successor"]).toBe("Brain/preferences/pref-new.md");

    const [predMeta] = parseFrontmatter(join(vault, pred));
    const [succMeta] = parseFrontmatter(join(vault, succ));
    expect(predMeta["valid_until"]).toBe(AT);
    expect(succMeta["valid_from"]).toBe(AT);
  });

  test("missing 'at' is an INVALID_PARAMS error", async () => {
    const server = new MCPServer({ vault, configPath: null });
    await initialize(server);
    const pred = writeFact("old");
    const succ = writeFact("new");
    const response = await call(server, {
      action: "temporal-replace",
      predecessor: pred,
      successor: succ,
    });
    expect(response.error).toBeDefined();
  });
});
