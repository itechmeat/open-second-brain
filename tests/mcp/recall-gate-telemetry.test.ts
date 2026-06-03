/**
 * `brain_recall_gate` telemetry emission + `brain_recall_telemetry`
 * gate operations (Workspace Insight Suite, t_65036e02).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listGateTelemetry } from "../../src/core/brain/gate-telemetry.ts";
import { buildToolTable, findTool, type ServerContext } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-gate-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: null };
}

function tool(name: string) {
  return findTool(buildToolTable("full"), name);
}

test("default off: the gate emits no telemetry", async () => {
  const decision = (await tool("brain_recall_gate").handler(ctx(), { prompt: "hello" })) as {
    retrieve: boolean;
  };
  expect(decision.retrieve).toBe(false);
  expect(listGateTelemetry(vault)).toHaveLength(0);
});

test("with recall_gate_telemetry on, decisions land as continuity records", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    telemetry_host: "hermes",
    session_id: "sess-1",
  });
  await tool("brain_recall_gate").handler(ctx(), { prompt: "hi" });
  const records = listGateTelemetry(vault);
  expect(records).toHaveLength(2);
  expect(records.some((r) => r.payload["decision"] === "retrieve")).toBe(true);
  expect(records.some((r) => r.payload["decision"] === "skip")).toBe(true);
  expect(records.some((r) => r.payload["host"] === "hermes")).toBe(true);
  // The raw prompt never lands on disk - assert against the PERSISTED
  // continuity files, not just the returned payloads, so a serializer
  // regression cannot slip through.
  for (const record of records) {
    expect(JSON.stringify(record.payload)).not.toContain("what did we decide");
  }
  const continuityDir = join(vault, "Brain", "log", "continuity");
  for (const name of readdirSync(continuityDir, { recursive: true }) as string[]) {
    const filePath = join(continuityDir, name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue; // directories
    }
    expect(content).not.toContain("what did we decide");
  }

  const summary = (await tool("brain_recall_telemetry").handler(ctx(), {
    operation: "gate_summary",
  })) as { total: number; retrieved: number; skipped: number };
  expect(summary.total).toBe(2);
  expect(summary.retrieved).toBe(1);
  expect(summary.skipped).toBe(1);

  const listed = (await tool("brain_recall_telemetry").handler(ctx(), {
    operation: "gate_list",
    limit: 1,
  })) as { total: number; records: unknown[] };
  expect(listed.total).toBe(1);
});

test("fail-open: a broken continuity store never breaks the gate decision", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  // The continuity directory path exists as a FILE, so every append throws.
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "log", "continuity"), "not a directory");
  const decision = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
  })) as { retrieve: boolean; reason: string };
  expect(typeof decision.retrieve).toBe("boolean");
  expect(typeof decision.reason).toBe("string");
});
