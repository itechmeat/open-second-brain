/**
 * Consolidated read tools (token-diet, t_3920db77): `brain_brief`,
 * `brain_analytics`, and `schema_inspect` dispatch by `view` to the
 * exact handlers of the tools they replace; every predecessor stays
 * registered as a deprecated delegating alias for at least one minor
 * release, so existing MCP clients migrate by renaming the call.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { buildToolTable, findTool, type ServerContext } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configPath: string;
let ctx: ServerContext;

const TOOLS = buildToolTable("full");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-consolidated-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writePreference(vault, {
    slug: "fixture",
    topic: "fixture",
    principle: "Always test consolidated views.",
    created_at: "2026-05-01T10:00:00Z",
    unconfirmed_until: "2026-05-15T10:00:00Z",
    status: "confirmed",
    evidenced_by: [],
  });
  ctx = { vault, configPath } as unknown as ServerContext;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function run(name: string, args: Record<string, unknown>): Promise<unknown> {
  return await findTool(TOOLS, name).handler(ctx, args);
}

/**
 * Volatile keys stripped before equality: handlers stamp a wall-clock
 * `generated_at` per call, so two back-to-back runs of the SAME code
 * path differ in that field alone. Everything else must match byte
 * for byte.
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (key, v) => (key === "generated_at" ? undefined : v));
}

describe("brain_brief", () => {
  const CASES: ReadonlyArray<{
    view: string;
    alias: string;
    args?: Record<string, unknown>;
  }> = [
    { view: "morning", alias: "brain_morning_brief" },
    { view: "daily", alias: "brain_daily_brief", args: { date: "2026-05-02" } },
    { view: "weekly", alias: "brain_weekly_synthesis", args: { week_end: "2026-05-08" } },
    { view: "monthly", alias: "brain_monthly_review", args: { month: "2026-05" } },
    { view: "operator", alias: "brain_operator_summary", args: { include_dream: false } },
    {
      view: "digest",
      alias: "brain_digest",
      args: { since: "2026-05-01T00:00:00Z", until: "2026-05-03T00:00:00Z" },
    },
  ];

  for (const { view, alias, args } of CASES) {
    test(`view=${view} returns exactly what ${alias} returns`, async () => {
      const consolidated = await run("brain_brief", { view, ...args });
      const predecessor = await run(alias, args ?? {});
      expect(stable(consolidated)).toBe(stable(predecessor));
    });
  }

  test("invalid view raises a clear error", async () => {
    await expect(run("brain_brief", { view: "hourly" })).rejects.toThrow(/view/);
  });

  test("missing view raises a clear error", async () => {
    await expect(run("brain_brief", {})).rejects.toThrow(/view/);
  });
});

describe("brain_analytics", () => {
  test("view=timeline returns exactly what brain_timeline returns", async () => {
    // Explicit window: the tool defaults `until` to wall-clock now,
    // which would differ between two back-to-back calls.
    const args = { pref_id: "pref-fixture", since: "2026-05-01", until: "2026-06-01" };
    const consolidated = await run("brain_analytics", { view: "timeline", ...args });
    const predecessor = await run("brain_timeline", args);
    expect(stable(consolidated)).toBe(stable(predecessor));
  });

  test("view=belief_evolution returns exactly what brain_belief_evolution returns", async () => {
    const args = { pref_id: "pref-fixture" };
    const consolidated = await run("brain_analytics", { view: "belief_evolution", ...args });
    const predecessor = await run("brain_belief_evolution", args);
    expect(stable(consolidated)).toBe(stable(predecessor));
  });

  test("view=concept_synthesis returns exactly what brain_concept_synthesis returns", async () => {
    const args = { id: "pref-fixture" };
    const consolidated = await run("brain_analytics", { view: "concept_synthesis", ...args });
    const predecessor = await run("brain_concept_synthesis", args);
    expect(stable(consolidated)).toBe(stable(predecessor));
  });

  test("view=attention_flows defaults the operation to list", async () => {
    const consolidated = await run("brain_analytics", { view: "attention_flows" });
    const predecessor = await run("brain_attention_flows", { operation: "list" });
    expect(stable(consolidated)).toBe(stable(predecessor));
  });

  test("invalid view raises a clear error", async () => {
    await expect(run("brain_analytics", { view: "recurrence" })).rejects.toThrow(/view/);
  });
});

describe("schema_inspect", () => {
  const CASES: ReadonlyArray<{ view: string; alias: string; args?: Record<string, unknown> }> = [
    { view: "graph", alias: "schema_graph" },
    { view: "lint", alias: "schema_lint" },
    { view: "stats", alias: "schema_stats" },
    { view: "orphans", alias: "schema_review_orphans" },
    { view: "active_pack", alias: "get_active_schema_pack" },
    { view: "packs", alias: "list_schema_packs" },
  ];

  for (const { view, alias, args } of CASES) {
    test(`view=${view} returns exactly what ${alias} returns`, async () => {
      const consolidated = await run("schema_inspect", { view, ...args });
      const predecessor = await run(alias, args ?? {});
      expect(stable(consolidated)).toBe(stable(predecessor));
    });
  }

  test("view=explain_type forwards the token", async () => {
    const consolidated = run("schema_inspect", { view: "explain_type", token: "no-such-token" });
    const predecessor = run("schema_explain_type", { token: "no-such-token" });
    // Both paths must agree - either both resolve or both reject with
    // the same message.
    const [a, b] = await Promise.allSettled([consolidated, predecessor]);
    expect(a.status).toBe(b.status);
    if (a.status === "rejected" && b.status === "rejected") {
      expect((a.reason as Error).message).toBe((b.reason as Error).message);
    } else if (a.status === "fulfilled" && b.status === "fulfilled") {
      expect(stable(a.value)).toBe(stable(b.value));
    }
  });

  test("invalid view raises a clear error", async () => {
    await expect(run("schema_inspect", { view: "everything" })).rejects.toThrow(/view/);
  });
});

describe("deprecated aliases", () => {
  const ALIASES = [
    "brain_morning_brief",
    "brain_daily_brief",
    "brain_weekly_synthesis",
    "brain_monthly_review",
    "brain_operator_summary",
    "brain_digest",
    "brain_timeline",
    "brain_attention_flows",
    "brain_belief_evolution",
    "brain_concept_synthesis",
    "schema_graph",
    "schema_lint",
    "schema_stats",
    "schema_review_orphans",
    "schema_explain_type",
    "get_active_schema_pack",
    "list_schema_packs",
  ];

  test("every alias stays registered with a one-line deprecation description", () => {
    for (const name of ALIASES) {
      const tool = findTool(TOOLS, name);
      expect(tool.description).toContain("Deprecated alias");
      expect(tool.description.length).toBeLessThanOrEqual(160);
    }
  });

  test("consolidated tools are registered", () => {
    for (const name of ["brain_brief", "brain_analytics", "schema_inspect"]) {
      expect(() => findTool(TOOLS, name)).not.toThrow();
    }
  });
});

describe("alias listing", () => {
  test("aliases are callable but hidden from the advertised tool list", async () => {
    const { MCPServer } = await import("../../src/mcp/server.ts");
    const server = new MCPServer({ vault, configPath });
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    await server.handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = (await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as { result: { tools: Array<{ name: string }> } };
    const listed = new Set(list.result.tools.map((t) => t.name));
    expect(listed.has("brain_brief")).toBe(true);
    expect(listed.has("brain_daily_brief")).toBe(false);
    expect(listed.has("schema_stats")).toBe(false);

    // Still callable: the alias resolves through tools/call.
    const call = (await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "brain_daily_brief", arguments: { date: "2026-05-02" } },
    })) as { result: { isError?: boolean } };
    expect(call.result.isError).not.toBe(true);
  });
});
