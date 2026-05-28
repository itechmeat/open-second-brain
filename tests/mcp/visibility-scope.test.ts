/**
 * `brain_search` honours the content-visibility scope (typed graph
 * semantics, unit 3) through the same handler path the MCP server uses.
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
  vault = mkdtempSync(join(tmpdir(), "o2b-vis-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-vis-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "public.md"),
    "---\ntitle: Public\n---\n\nshared lattice notes about widgets",
  );
  writeFileSync(
    join(vault, "notes", "secret.md"),
    "---\nvisibility: [private]\n---\n# Secret\n\nclassified lattice notes about widgets",
  );
  ctx = { vault, configPath };
  const config = resolveSearchConfig({ vault, configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function paths(out: { results: Array<{ path: string }> }): string[] {
  return out.results.map((r) => r.path).toSorted();
}

describe("brain_search visibility scope", () => {
  test("a private page is hidden by default", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool.handler(ctx as any, { query: "lattice widgets" })) as {
      results: Array<{ path: string }>;
    };
    expect(paths(out)).toEqual(["notes/public.md"]);
  });

  test("the private page appears when its visibility is requested", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search")!;
    const out = (await tool.handler(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx as any,
      { query: "lattice widgets", visibility: ["private"] },
    )) as { results: Array<{ path: string }> };
    expect(paths(out)).toEqual(["notes/public.md", "notes/secret.md"]);
  });

  test("a non-array visibility argument is rejected", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(tool.handler(ctx as any, { query: "lattice", visibility: "private" })).rejects.toThrow(
      /visibility/,
    );
  });
});
