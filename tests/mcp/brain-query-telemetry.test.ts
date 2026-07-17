/**
 * `brain_query` recall telemetry (Project History Suite, t_405b8053
 * delta): the one query surface v0.39.0 left without telemetry now
 * mirrors the brain_search pattern - per-call opt-in, lazy gated emit,
 * kind-only payload, fail-open.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-query-telemetry-"));
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

test("default off: brain_query emits zero continuity records", async () => {
  await tool("brain_query").handler(ctx(), { since: "2026-06-01T00:00:00Z" });
  expect(listRecallTelemetry(vault)).toHaveLength(0);
});

test("opt-in: one record with mode query, kind-only payload, no raw values persisted", async () => {
  const res = (await tool("brain_query").handler(ctx(), {
    topic: "secret-topic-value",
    telemetry: true,
    telemetry_host: "hermes",
    session_id: "sess-q1",
  })) as Record<string, unknown>;
  expect(res["mode"]).toBe("topic");

  const records = listRecallTelemetry(vault, { mode: "query" });
  expect(records).toHaveLength(1);
  const payload = records[0]!.payload;
  expect(payload["mode"]).toBe("query");
  expect(payload["host"]).toBe("hermes");
  expect(payload["session_id"]).toBe("sess-q1");
  expect(payload["status"]).toBe("empty");
  expect(typeof payload["duration_ms"]).toBe("number");
  const metadata = payload["metadata"] as Record<string, unknown>;
  expect(metadata["query_kind"]).toBe("topic");
  // The supplied topic value never lands anywhere - payload or disk.
  expect(JSON.stringify(payload)).not.toContain("secret-topic-value");
  const continuityDir = join(vault, "Brain", "log", "continuity");
  for (const name of readdirSync(continuityDir, { recursive: true }) as string[]) {
    let content: string;
    try {
      content = readFileSync(join(continuityDir, name), "utf8");
    } catch {
      continue; // directories
    }
    expect(content).not.toContain("secret-topic-value");
  }
});

test("error path: a failing preference lookup still emits, then rethrows", async () => {
  await expect(
    tool("brain_query").handler(ctx(), {
      preference: "pref-does-not-exist",
      telemetry: true,
    }),
  ).rejects.toThrow();
  const records = listRecallTelemetry(vault, { mode: "query" });
  expect(records).toHaveLength(1);
  expect(records[0]!.payload["status"]).toBe("error");
  expect(JSON.stringify(records[0]!.payload)).not.toContain("pref-does-not-exist");
});

test("fail-open: a broken continuity store never breaks the query result", async () => {
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "log", "continuity"), "not a directory");
  const res = (await tool("brain_query").handler(ctx(), {
    since: "2026-06-01T00:00:00Z",
    telemetry: true,
  })) as Record<string, unknown>;
  expect(res["mode"]).toBe("since");
});
