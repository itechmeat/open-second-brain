/**
 * `brain_context_receipts` answers at the caller's reach for the
 * operator rules the SessionStart hook injected.
 *
 * The hook records a receipt item for the standing rules and the scoped
 * rules, the scoped characters in its budget block, and whole-injection
 * totals that include both blocks. Below local reach none of that may say
 * whether operator rules applied or how long they were: a vault whose
 * sessions injected the rules answers byte-identically (receipt ids,
 * timestamps and the vault reference masked) to the same vault without
 * them. At local reach the rules stay visible.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { writeVaultPointer } from "../../src/core/brain/portability/pointer.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import type { MCPServerRuntimeOptions } from "../../src/mcp/server.ts";
import { homeEnv } from "../helpers/platform.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);
const ACTIVE_BODY =
  "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n" +
  "# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n";
const OPERATOR_RULE_IDS = ["standing-rules", "scoped-rules"];

let tmp: string;
let configHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-receipts-reach-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-receipts-reach-cfg-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** A vault and a linked project; with `rules`, a constitution and a project rule. */
function vaultFor(name: string, rules: boolean): { vault: string; project: string } {
  const vault = join(tmp, name, "vault");
  const project = join(tmp, name, "proj-x");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(vault, "Brain", "active.md"), ACTIVE_BODY, "utf8");
  writeVaultPointer(project, vault);
  if (rules) {
    writeFileSync(join(vault, "Brain", "standing-rules.md"), "Never force-push to main.", "utf8");
    mkdirSync(join(vault, "Brain", "standing-rules", "project"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "standing-rules", "project", "proj-x.md"),
      "zzscopedreceiptzz keep the changelog terse",
      "utf8",
    );
  }
  return { vault, project };
}

async function runHook(vault: string, cwd: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(configHome),
      OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
      VAULT_DIR: vault,
      O2B_DEVICE_ID: "",
    },
  });
  proc.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", cwd }));
  await proc.stdin.end();
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(await proc.exited).toBe(0);
}

async function callReceipts(
  vault: string,
  runtime: MCPServerRuntimeOptions,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const configPath = join(dirname(vault), "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  const server = new MCPServer({ vault, configPath }, runtime);
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "receipts-reach-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context_receipts", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text);
}

/** Every answer of the tool for the one receipt the hook wrote. */
async function answers(
  vault: string,
  runtime: MCPServerRuntimeOptions,
): Promise<Record<string, unknown>> {
  const list = await callReceipts(vault, runtime, { operation: "list" });
  const receipts = list["receipts"] as ReadonlyArray<{ id: string }>;
  expect(receipts.length).toBe(1);
  const id = receipts[0]!.id;
  const show = await callReceipts(vault, runtime, { operation: "show", id });
  const summary = await callReceipts(vault, runtime, { operation: "summary" });
  return JSON.parse(JSON.stringify({ list, show, summary }).replaceAll(id, "<id>"));
}

function masked(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g, "<ts>")
    .replace(/"vault_path":"[^"]*"/g, '"vault_path":"<vault>"');
}

async function abProbe(
  runtime: MCPServerRuntimeOptions,
): Promise<{ withRules: Record<string, unknown>; withoutRules: Record<string, unknown> }> {
  const a = vaultFor("a", true);
  const b = vaultFor("b", false);
  await runHook(a.vault, a.project);
  await runHook(b.vault, b.project);
  return {
    withRules: await answers(a.vault, runtime),
    withoutRules: await answers(b.vault, runtime),
  };
}

describe("brain_context_receipts and the operator rules", () => {
  test("below local reach a session that injected the rules answers like one that did not", async () => {
    const { withRules, withoutRules } = await abProbe({});
    for (const id of OPERATOR_RULE_IDS) expect(JSON.stringify(withRules)).not.toContain(id);
    expect(JSON.stringify(withRules)).not.toContain("scoped_rules_chars");
    expect(masked(withRules)).toBe(masked(withoutRules));
  });

  test("at local reach the rules stay visible", async () => {
    const { withRules, withoutRules } = await abProbe({ reach: TRANSPORT_REACH.local });
    const show = withRules["show"] as { payload: Record<string, unknown> };
    const ids = (show.payload["items"] as ReadonlyArray<{ id: string }>).map((item) => item.id);
    expect(ids).toEqual(["standing-rules", "scoped-rules", "active-body"]);
    const budget = show.payload["budget"] as Record<string, unknown>;
    expect(budget["scoped_rules_chars"]).toBeGreaterThan(0);
    expect(masked(withRules)).not.toBe(masked(withoutRules));
  });
});
