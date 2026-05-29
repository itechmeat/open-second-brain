/**
 * `brain_search` surfaces a result page's typed frontmatter relations
 * (typed graph semantics, unit 2). Exercises the tool through the same
 * handler path the MCP server uses, against a freshly indexed vault.
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
  vault = mkdtempSync(join(tmpdir(), "o2b-rel-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-rel-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "alpha.md"),
    [
      "---",
      "title: Alpha",
      "contradicts: [[beta]]",
      'superseded_by: "[[gamma]]"',
      "---",
      "",
      "The quick brown fox jumps over the lazy dog.",
    ].join("\n"),
  );
  ctx = { vault, configPath };
  const config = resolveSearchConfig({ vault, configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search typed relations", () => {
  test("a result page's declared relations surface inline", async () => {
    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search");
    expect(tool).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool!.handler(ctx as any, { query: "quick fox" })) as {
      results: Array<{ path: string; relations?: Array<{ relation: string; target: string }> }>;
    };
    const hit = out.results.find((r) => r.path.endsWith("alpha.md"));
    expect(hit).toBeDefined();
    const summary = (hit!.relations ?? []).map((r) => `${r.relation}:${r.target}`).toSorted();
    expect(summary).toEqual(["contradicts:beta", "superseded_by:gamma"]);
  });

  test("a result page with no relations omits the field", async () => {
    writeFileSync(
      join(vault, "notes", "plain.md"),
      "---\ntitle: Plain\n---\n\nThe quick brown fox again, plainly.",
    );
    const config = resolveSearchConfig({ vault, configPath: ctx.configPath });
    await indexVault(config, {});

    const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool.handler(ctx as any, { query: "plainly" })) as {
      results: Array<{ path: string; relations?: unknown }>;
    };
    const hit = out.results.find((r) => r.path.endsWith("plain.md"));
    expect(hit).toBeDefined();
    expect(hit!.relations).toBeUndefined();
  });
});
