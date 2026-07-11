/**
 * Acceptance: the --expect / --strict count guards and matched-vs-changed
 * reporting wired into brain_hygiene apply (t_67e491f6). A mismatched --expect
 * or a guardless --strict aborts BEFORE writing (the vault is untouched); a
 * matching guard applies and reports honest matched/changed counts.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-count-guard-"));
  bootstrapBrain(vault);
  writePref("dup-a", "same-topic", "collect metrics before optimizing the code");
  writePref("dup-b", "same-topic", "collect metrics before optimizing the code base");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, topic: string, principle: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      `topic: ${topic}`,
      "_status: confirmed",
      `principle: ${principle}`,
      "created_at: 2026-01-01T00:00:00Z",
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function init(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(server: MCPServer, args: Record<string, unknown>): Promise<any> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_hygiene", arguments: args },
  })) as any;
}

async function scanIds(server: MCPServer): Promise<string[]> {
  const scan = await call(server, { mode: "scan", detectors: ["dedup"] });
  const findings = scan.result.structuredContent.findings as Array<{ id: string }>;
  return findings.map((f) => f.id);
}

test("a mismatched --expect aborts the apply without writing", async () => {
  const server = new MCPServer({ vault });
  await init(server);
  const ids = await scanIds(server);
  expect(ids.length).toBeGreaterThan(0);

  const r = await call(server, { mode: "apply", ids, expect: 999 });
  // INVALID_PARAMS with the guard message; nothing is deleted.
  expect(r.error.code).toBe(-32602);
  expect(r.error.message).toContain("--expect 999");
  expect(existsSync(join(vault, "Brain", "preferences", "pref-dup-b.md"))).toBe(true);
});

test("--strict refuses a guardless apply", async () => {
  const server = new MCPServer({ vault });
  await init(server);
  const ids = await scanIds(server);
  const r = await call(server, { mode: "apply", ids, strict: true });
  expect(r.error.code).toBe(-32602);
  expect(r.error.message.toLowerCase()).toContain("strict");
  expect(existsSync(join(vault, "Brain", "preferences", "pref-dup-b.md"))).toBe(true);
});

test("a matching --expect applies and reports matched vs changed", async () => {
  const server = new MCPServer({ vault });
  await init(server);
  const ids = await scanIds(server);
  const matched = ids.length;
  const r = await call(server, { mode: "apply", ids, expect: matched });
  const s = r.result.structuredContent;
  expect(s.matched).toBe(matched);
  expect(s.changed).toBe(s.applied.length);
  expect(existsSync(join(vault, "Brain", "preferences", "pref-dup-b.md"))).toBe(false);
});
