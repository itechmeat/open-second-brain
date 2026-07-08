import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-checkpoint-tool-"));
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
      clientInfo: { name: "session-checkpoint-test", version: "0" },
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
    params: { name: "brain_session_checkpoint", arguments: args },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

function inboxSignalCount(): number {
  const inbox = join(vault, "Brain", "inbox");
  if (!existsSync(inbox)) return 0;
  return readdirSync(inbox).filter((n) => n.startsWith("sig-") && n.endsWith(".md")).length;
}

const CHECKPOINT_A = {
  session_id: "s1",
  signals: [
    { topic: "prefer-tabs", signal: "positive", principle: "Use tabs for indentation." },
    { topic: "no-force-push", signal: "negative", principle: "Never force-push shared branches." },
  ],
  request: "Wire up the checkpoint tool",
  decisions: ["Reuse the C1 idempotency ledger"],
  learnings: ["Checkpoint = signals + summary in one round-trip"],
  next_steps: ["Ship it"],
};

describe("brain_session_checkpoint tool", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_session_checkpoint"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_session_checkpoint"),
    ).toBeUndefined();
  });

  test("fresh session writes all items once; retry with same content is idempotent", async () => {
    const first = payload(await call(CHECKPOINT_A));
    expect(first["status"]).toBe("ok");
    expect(first["deduped"]).toBe(false);
    expect((first["signals"] as unknown[]).length).toBe(2);
    expect((first["summary"] as Record<string, unknown>)["id"]).toBeDefined();
    expect((first["partial"] as unknown[]).length).toBe(0);
    expect(inboxSignalCount()).toBe(2);

    // Retry the exact same checkpoint: deduped at the session key, no
    // duplicate signals appended and no second summary digest.
    const retry = payload(await call(CHECKPOINT_A));
    expect(retry["status"]).toBe("ok");
    expect(retry["deduped"]).toBe(true);
    expect(inboxSignalCount()).toBe(2);
  });

  test("a checkpoint with an item needing review returns status mixed with the partial list", async () => {
    const mixed = payload(
      await call({
        session_id: "s2",
        signals: [
          { topic: "good-one", signal: "positive", principle: "Keep it green." },
          // Invalid sign -> this item needs review, must not silently drop.
          { topic: "bad-one", signal: "sideways", principle: "This one is malformed." },
        ],
      }),
    );
    expect(mixed["status"]).toBe("mixed");
    const partial = mixed["partial"] as Array<Record<string, unknown>>;
    expect(partial.length).toBe(1);
    expect(partial[0]!["index"]).toBe(1);
    // The valid signal still landed.
    expect((mixed["signals"] as unknown[]).length).toBe(1);
    expect(inboxSignalCount()).toBe(1);
  });

  test("retry with the same session id but different content is a payload_mismatch error", async () => {
    const ok = payload(await call(CHECKPOINT_A));
    expect(ok["status"]).toBe("ok");

    const response = await call({
      ...CHECKPOINT_A,
      learnings: ["A materially different learning changes the checkpoint content"],
    });
    expect(response.error).toBeDefined();
    expect((response.error as { code: number }).code).toBe(-32602);
    expect((response.error as { message: string }).message).toContain("different payload");
  });

  test("missing session_id is an invalid-params error", async () => {
    const response = await call({ signals: [] });
    expect(response.error).toBeDefined();
    expect((response.error as { code: number }).code).toBe(-32602);
  });
});
