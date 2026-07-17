/**
 * Consolidated read tools (token-diet, t_3920db77): `brain_brief`,
 * `brain_analytics`, and `schema_inspect` dispatch by `view`. The
 * per-view predecessor aliases were removed in 1.0.0 (epic
 * t_a77ade0a) - their tombstones live in `REMOVED_TOOLS` and are
 * covered by `removed-tools.test.ts`; here every consolidated view
 * must keep working on its own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

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

describe("brain_brief", () => {
  const CASES: ReadonlyArray<{ view: string; args?: Record<string, unknown> }> = [
    { view: "morning" },
    { view: "daily", args: { date: "2026-05-02" } },
    { view: "weekly", args: { week_end: "2026-05-08" } },
    { view: "monthly", args: { month: "2026-05" } },
    { view: "operator", args: { include_dream: false } },
    { view: "digest", args: { since: "2026-05-01T00:00:00Z", until: "2026-05-03T00:00:00Z" } },
  ];

  for (const { view, args } of CASES) {
    test(`view=${view} resolves to a structured envelope`, async () => {
      const result = await run("brain_brief", { view, ...args });
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
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
  test("view=timeline returns an events window", async () => {
    const args = { pref_id: "pref-fixture", since: "2026-05-01", until: "2026-06-01" };
    const result = (await run("brain_analytics", { view: "timeline", ...args })) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(result["events"])).toBe(true);
  });

  test("view=belief_evolution returns transitions for a preference", async () => {
    const result = (await run("brain_analytics", {
      view: "belief_evolution",
      pref_id: "pref-fixture",
    })) as Record<string, unknown>;
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  test("view=concept_synthesis resolves for a known id", async () => {
    const result = await run("brain_analytics", { view: "concept_synthesis", id: "pref-fixture" });
    expect(result).toBeDefined();
  });

  test("view=attention_flows defaults the operation to list", async () => {
    const result = (await run("brain_analytics", { view: "attention_flows" })) as Record<
      string,
      unknown
    >;
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  test("invalid view raises a clear error", async () => {
    await expect(run("brain_analytics", { view: "recurrence" })).rejects.toThrow(/view/);
  });
});

describe("schema_inspect", () => {
  for (const view of ["graph", "lint", "stats", "orphans", "active_pack", "packs"]) {
    test(`view=${view} resolves`, async () => {
      const result = await run("schema_inspect", { view });
      expect(result).toBeDefined();
    });
  }

  test("view=explain_type forwards the token", async () => {
    // The explanation must echo the normalized token, proving the
    // argument reaches the underlying handler.
    const result = (await run("schema_inspect", {
      view: "explain_type",
      token: "no-such-token",
    })) as Record<string, unknown>;
    expect(result["token"]).toBe("no-such-token");
  });

  test("invalid view raises a clear error", async () => {
    await expect(run("schema_inspect", { view: "everything" })).rejects.toThrow(/view/);
  });
});

describe("timezone presentation (t_2ccadc6a)", () => {
  test("a configured timezone adds additive local fields to brief envelopes", async () => {
    atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\ntimezone: Asia/Tokyo\n`);
    const result = (await run("brain_brief", { view: "daily", date: "2026-06-05" })) as Record<
      string,
      unknown
    >;
    expect(result["timezone"]).toBe("Asia/Tokyo");
    expect(String(result["local_time"])).toContain("+09:00");
  });

  test("no configured timezone keeps the envelope unchanged", async () => {
    const result = (await run("brain_brief", { view: "daily", date: "2026-06-05" })) as Record<
      string,
      unknown
    >;
    expect(result["timezone"]).toBeUndefined();
    expect(result["local_time"]).toBeUndefined();
  });
});

describe("consolidated registration", () => {
  test("consolidated tools are registered and advertised", async () => {
    for (const name of ["brain_brief", "brain_analytics", "schema_inspect"]) {
      expect(() => findTool(TOOLS, name)).not.toThrow();
    }
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
    expect(listed.has("brain_analytics")).toBe(true);
    expect(listed.has("schema_inspect")).toBe(true);
    // The 1.0.0 sweep removed the alias layer entirely.
    expect(listed.has("brain_daily_brief")).toBe(false);
    expect(listed.has("schema_stats")).toBe(false);
  });
});
