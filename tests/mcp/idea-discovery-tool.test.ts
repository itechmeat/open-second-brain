/**
 * `brain_idea_discovery` MCP tool (Workspace Insight Suite, t_8722a62a).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listTriggers } from "../../src/core/brain/triggers/store.ts";
import { buildToolTable, findTool, type ServerContext } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let ctx: ServerContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ideas-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  const orphan = join(vault, "Brain", "notes", "orphan.md");
  writeFileSync(orphan, "# Orphan research\n");
  const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  utimesSync(orphan, past, past);
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("returns ranked ideas and optionally enqueues triggers", async () => {
  const tool = findTool(buildToolTable("full"), "brain_idea_discovery");
  const result = (await tool.handler(ctx, { triggers: true })) as {
    ideas: Array<{ kind: string; title: string }>;
    triggers_created: number;
  };
  expect(result.ideas.some((i) => i.title === "orphan")).toBe(true);
  expect(result.triggers_created).toBeGreaterThan(0);
  expect(listTriggers(vault, { now: new Date() }).length).toBe(result.triggers_created);
});

test("cap above 50 is rejected", () => {
  const tool = findTool(buildToolTable("full"), "brain_idea_discovery");
  expect(() => tool.handler(ctx, { cap: 99 })).toThrow();
});
