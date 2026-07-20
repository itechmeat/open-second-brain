/**
 * `brain_search` honours the composite session/project scope filter
 * (t_37c05a34) through the same handler path the MCP server uses. Omitting
 * the params is byte-identical to an unfiltered search.
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
  vault = mkdtempSync(join(tmpdir(), "o2b-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-scope-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "s1.md"), "---\nsession: s1\n---\n\nlattice widgets one");
  writeFileSync(join(vault, "notes", "s2.md"), "---\nsession: s2\n---\n\nlattice widgets two");
  writeFileSync(join(vault, "notes", "shared.md"), "# Shared\n\nlattice widgets shared");
  ctx = { vault, configPath };
  await indexVault(resolveSearchConfig({ vault, configPath }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function paths(out: { results: Array<{ path: string }> }): string[] {
  return out.results.map((r) => r.path).toSorted();
}

const tool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

describe("brain_search composite scope filter", () => {
  test("session_scope returns only that session plus unscoped pages", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool().handler(ctx as any, {
      query: "lattice widgets",
      session_scope: "s1",
    })) as { results: Array<{ path: string }> };
    expect(paths(out)).toEqual(["notes/s1.md", "notes/shared.md"]);
  });

  test("omitting the scope params returns every page", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool().handler(ctx as any, { query: "lattice widgets" })) as {
      results: Array<{ path: string }>;
    };
    expect(paths(out)).toEqual(["notes/s1.md", "notes/s2.md", "notes/shared.md"]);
  });
});
