import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SKILL_TOOLS } from "../../src/mcp/skill-tools.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let configPath: string;
let ctx: ServerContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-attach-tool-"));
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  const skillDir = join(tmp, "skills", "embeddings-setup");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: embeddings-setup\ndescription: Configure embedding providers for semantic search.\n---\n\n# Embeddings",
  );
  ctx = { vault, configPath, repoRoot: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function attach() {
  return SKILL_TOOLS.find((t) => t.name === "skills_attach")!;
}

test("skills_attach is disabled by default (config key absent)", async () => {
  const result = (await attach().handler(ctx, { query: "embedding search" })) as {
    enabled: boolean;
    block: string;
    skills: unknown[];
  };
  expect(result.enabled).toBe(false);
  expect(result.block).toBe("");
  expect(result.skills).toHaveLength(0);
});

test("skills_attach returns a scored block when skill_auto_attach is true", async () => {
  writeFileSync(configPath, `vault: "${ctx.vault}"\nskill_auto_attach: "true"\n`);
  const result = (await attach().handler(ctx, { query: "configure embedding search" })) as {
    enabled: boolean;
    block: string;
    skills: Array<{ name: string; score: number }>;
  };
  expect(result.enabled).toBe(true);
  expect(result.block).toContain("embeddings-setup");
  expect(result.skills[0]!.name).toBe("embeddings-setup");
  expect(result.skills[0]!.score).toBeGreaterThan(0);
});

test("an irrelevant turn attaches nothing even when enabled", async () => {
  writeFileSync(configPath, `vault: "${ctx.vault}"\nskill_auto_attach: "true"\n`);
  const result = (await attach().handler(ctx, { query: "qqq zzz" })) as {
    enabled: boolean;
    block: string;
  };
  expect(result.enabled).toBe(true);
  expect(result.block).toBe("");
});

test("skills_attach is registered in the full tool table", () => {
  expect(() => findTool(buildToolTable("full"), "skills_attach")).not.toThrow();
});
