/**
 * `brain_search { global: true }` (Workspace Insight Suite,
 * t_72a22658): cross-vault union over MCP with origin labels.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addRecallSource } from "../../src/core/brain/portability/recall-sources.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { buildToolTable, findTool, type ServerContext } from "../../src/mcp/tools.ts";
import { writeMd } from "../helpers/search-fixtures.ts";

let tmp: string;
let vault: string;
let external: string;
let configPath: string;
let ctx: ServerContext;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-global-"));
  vault = join(tmp, "vault");
  external = join(tmp, "external");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(external, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  writeMd(vault, "Brain/notes/local.md", "# Local\n\nA chimera sighting in the local vault.");
  writeMd(external, "Brain/notes/ext.md", "# Ext\n\nA chimera sighting in the external vault.");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  await indexVault(resolveSearchConfig({ vault: external, configPath }));
  addRecallSource(configPath, vault, "team", external);
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function searchTool() {
  return findTool(buildToolTable("full"), "brain_search");
}

test("global search returns origin-labelled results from both vaults", async () => {
  const result = (await searchTool().handler(ctx, { query: "chimera", global: true })) as {
    results: Array<{ origin?: string; reasons: string[] }>;
    total: number;
  };
  const origins = new Set(result.results.map((r) => r.origin));
  expect(origins).toEqual(new Set(["local", "source/team"]));
  expect(result.total).toBeGreaterThanOrEqual(2);
});

test("default (no global flag) stays scoped to the active vault", async () => {
  const result = (await searchTool().handler(ctx, { query: "chimera" })) as {
    results: Array<{ origin?: string }>;
  };
  expect(result.results.length).toBeGreaterThan(0);
  expect(result.results.every((r) => r.origin === undefined)).toBe(true);
});
