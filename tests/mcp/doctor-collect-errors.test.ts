/*
 * `brain_doctor` renders the maintenance collector's absorbed scan
 * failures as a named `collect_errors` row (review M10). The collector
 * is fail-soft either way; before the observers were passed, one
 * throwing scan left the doctor, digest and health reports thin and
 * looking healthy - exactly the difference the row exists to name.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer } from "../../src/mcp/index.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface RpcResponse {
  readonly error?: { code: number; message: string; data?: Record<string, unknown> };
  readonly result?: {
    structuredContent?: Record<string, unknown>;
    content?: ReadonlyArray<{ text?: string }>;
  };
}

function fixture(breakPreferences: boolean, reach?: TransportReach): MCPServer {
  const base = mkdtempSync(join(tmpdir(), "o2b-doctor-collect-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "source.md"), "# Widget source\n\nBody text.\n");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  if (breakPreferences) {
    // A FILE at Brain/preferences makes the dedup scan's readdir refuse;
    // every doctor check degrades instead of throwing.
    rmSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(join(vault, "Brain", "preferences"), "not a directory", "utf8");
  }
  return new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : {});
}

async function callDoctor(server: MCPServer): Promise<RpcResponse> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 7,
    method: "tools/call",
    params: { name: "brain_doctor", arguments: {} },
  })) as RpcResponse;
}

test("a refused scan is rendered as a named collect_errors row", async () => {
  // Local reach: the operator's own surface carries the raised message.
  const res = await callDoctor(fixture(true, TRANSPORT_REACH.local));
  expect(res.error).toBeUndefined();
  const s = res.result?.structuredContent ?? {};
  // The break can refuse more than one scan on this surface; the row is
  // about WHAT refused, so the assertion is on the shape and the named
  // dedup entry.
  const errors = (s["collect_errors"] ?? []) as ReadonlyArray<{
    scan: string;
    message: string;
  }>;
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.some((e) => e.scan === "dedup")).toBe(true);
  for (const e of errors) {
    expect(e.message.replace(/\\/g, "/")).toContain("preferences");
  }
});

test("below local reach the row names the scan and errno, never the host path", async () => {
  const res = await callDoctor(fixture(true, TRANSPORT_REACH.remote));
  expect(res.error).toBeUndefined();
  const errors = (res.result?.structuredContent?.["collect_errors"] ?? []) as ReadonlyArray<{
    scan: string;
    message: string;
  }>;
  expect(errors.some((e) => e.scan === "dedup")).toBe(true);
  for (const e of errors) {
    expect(e.message).toMatch(new RegExp(`^${e.scan} scan failed \\(`));
    expect(e.message).not.toContain(tmpdir());
  }
});

test("a healthy vault's payload carries no collect_errors row", async () => {
  const res = await callDoctor(fixture(false));
  expect(res.error).toBeUndefined();
  const s = res.result?.structuredContent ?? {};
  expect(s["collect_errors"]).toBeUndefined();
  expect(Array.isArray(s["suggested_actions"])).toBe(true);
});
