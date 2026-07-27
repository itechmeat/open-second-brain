/**
 * Unit 4 (t_75597bb9): the `brain_feedback` MCP surface of the
 * unroutable-capture routing hint.
 *
 * The tool records the signal exactly as before and, when the call
 * resolved no effective scope, carries the structured hint alongside the
 * write. The hint is a field on an otherwise unchanged payload: it never
 * gates the write and never appears when the vault has no scope corpus.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { resolveNextStep } from "../../src/core/brain/next-step.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { CAPTURE_ROUTING_HINT_CODE } from "../../src/core/brain/write-advisory.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configPath: string;

const NOW = "2026-07-27T12:00:00Z";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-routing-hint-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "routing-hint-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as
    | { result: { content: ReadonlyArray<{ type: string; text: string }> } }
    | { error: { message: string } };
  if ("error" in response) throw new Error(response.error.message);
  return JSON.parse(response.result.content[0]!.text);
}

function confirmScoped(slug: string, scope: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: NOW,
    unconfirmed_until: NOW,
    confirmed_at: NOW,
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: ["[[sig-2026-07-27-seed]]"],
    scope,
  });
}

const capture = { topic: "unrouted", signal: "positive", principle: "capture this somewhere" };

describe("brain_feedback - unroutable-capture routing hint", () => {
  test("a scope-less call on a scoped vault carries the hint beside the write", async () => {
    confirmScoped("tabs", "coding");
    confirmScoped("naming", "coding");
    confirmScoped("tone", "writing");
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const payload = await callTool(server, "brain_feedback", capture);

    // The write landed.
    expect(payload["kind"]).toBe("signal");
    expect(String(payload["signal_id"])).toMatch(/^sig-/);
    const hint = payload["routing_hint"] as {
      missing_signal: string;
      code: string;
      candidates: ReadonlyArray<{ scope: string; documents: number }>;
      next_command?: string;
    };
    expect(hint.missing_signal).toBe("scope");
    expect(hint.code).toBe(CAPTURE_ROUTING_HINT_CODE);
    expect(hint.candidates).toEqual([
      { scope: "coding", documents: 2 },
      { scope: "writing", documents: 1 },
    ]);
    expect(hint.next_command).toBe(resolveNextStep(CAPTURE_ROUTING_HINT_CODE)!.nextCommand);
  });

  test("an explicit scope leaves the payload without the key", async () => {
    confirmScoped("tone", "writing");
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const payload = await callTool(server, "brain_feedback", { ...capture, scope: "coding" });

    expect(String(payload["signal_id"])).toMatch(/^sig-/);
    expect("routing_hint" in payload).toBe(false);
  });

  test("a vault with no scope corpus stays silent", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const payload = await callTool(server, "brain_feedback", capture);

    expect(String(payload["signal_id"])).toMatch(/^sig-/);
    expect("routing_hint" in payload).toBe(false);
  });
});
