/**
 * `brain_search` surfaces the explainable-recall `reasons` array on
 * every result. Exercises the tool through the same handler path the
 * MCP server uses, against a freshly indexed scratch vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-reasons-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-reasons-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "alpha.md"),
    "---\ntitle: Alpha\n---\n\nThe quick brown fox jumps over the lazy dog.\n",
  );
  ctx = { vault, configPath };
  const config = resolveSearchConfig({ vault, configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search reasons", () => {
  test("every result carries a non-empty reasons array", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search");
    expect(tool).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool!.handler(ctx as any, { query: "quick fox" })) as {
      results: Array<{ reasons: string[] }>;
      total: number;
    };
    expect(out.total).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(Array.isArray(r.reasons)).toBe(true);
      expect(r.reasons.length).toBeGreaterThan(0);
      // keyword-only scratch vault → at least the bm25 layer is present.
      expect(r.reasons.some((x) => x.startsWith("fts5_bm25"))).toBe(true);
    }
  });
});
