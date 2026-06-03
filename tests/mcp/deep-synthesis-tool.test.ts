/**
 * `brain_deep_synthesis` MCP tool (Workspace Insight Suite, t_04e94382).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { listTriggers } from "../../src/core/brain/triggers/store.ts";
import { buildToolTable, findTool, type ServerContext } from "../../src/mcp/tools.ts";
import { writeMd } from "../helpers/search-fixtures.ts";

let tmp: string;
let vault: string;
let ctx: ServerContext;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-synth-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  writeMd(
    vault,
    "Brain/notes/claim.md",
    "---\ncontradicts: [[counter]]\n---\n# Claim\n\nWyverns roost in cliffs. See [[lost-note]].",
  );
  writeMd(vault, "Brain/notes/counter.md", "# Counter\n\nWyverns roost in forests.");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("returns the dossier and optionally enqueues triggers", async () => {
  const tool = findTool(buildToolTable("full"), "brain_deep_synthesis");
  const report = (await tool.handler(ctx, { topic: "wyverns", triggers: true })) as {
    checked: string[];
    contradictions: Array<{ target: string }>;
    gaps: Array<{ target: string }>;
    triggers_created: number;
  };
  expect(report.checked).toContain("knowledge_gaps");
  expect(report.contradictions[0]!.target).toBe("counter");
  expect(report.gaps[0]!.target).toBe("lost-note");
  expect(report.triggers_created).toBeGreaterThanOrEqual(2);
  expect(listTriggers(vault, { now: new Date() }).length).toBe(report.triggers_created);
});

test("rejects a missing topic", () => {
  const tool = findTool(buildToolTable("full"), "brain_deep_synthesis");
  expect(() => tool.handler(ctx, {})).toThrow();
});
