/**
 * `brain_search_expand` takes the visibility and session/project scope
 * arguments `brain_search` takes, and withholds what they withhold: a card
 * handed out under a scope expands under the same scope, and the bare
 * chunk id of a page outside it is refused like an absent chunk.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const WORD = "zzexpandscopezz";

let vault: string;
let configHome: string;

const searchTool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;
const expandTool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search_expand")!;

function ctx(): ServerContext {
  return {
    vault,
    configPath: join(configHome, "config.yaml"),
    repoRoot: null,
    reach: TRANSPORT_REACH.local,
  };
}

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-expand-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-expand-scope-cfg-"));
  atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  const write = (rel: string, frontmatter: string): void => {
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, rel), `---\n${frontmatter}---\n\nnotes about ${WORD}.\n`);
  };
  write("notes/team.md", "title: Team\nvisibility: [team]\n");
  write("notes/beta.md", "title: Beta\nproject: beta\n");
  await indexVault(resolveSearchConfig({ vault, configPath: join(configHome, "config.yaml") }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function chunkOf(path: string, args: Record<string, unknown>): Promise<number> {
  const out = (await searchTool().handler(ctx(), {
    query: WORD,
    disclosure: "cards",
    ...args,
  })) as { cards?: Array<{ path: string; chunk_id: number }> };
  const card = (out.cards ?? []).find((c) => c.path === path);
  expect(card).toBeDefined();
  return card!.chunk_id;
}

async function expand(args: Record<string, unknown>): Promise<string> {
  const out = (await expandTool().handler(ctx(), args)) as { note: { path: string } };
  return out.note.path;
}

test("a tagged page expands under the visibility scope its card came from, and only then", async () => {
  const chunk = await chunkOf("notes/team.md", { visibility: ["team"] });
  expect(await expand({ chunk_id: chunk, visibility: ["team"] })).toBe("notes/team.md");
  await expect(expand({ chunk_id: chunk })).rejects.toThrow(`chunk not found: ${chunk}`);
  await expect(expand({ chunk_id: chunk, visibility: ["ops"] })).rejects.toThrow(
    `chunk not found: ${chunk}`,
  );
});

test("another project's page is refused under a project scope", async () => {
  const chunk = await chunkOf("notes/beta.md", {});
  expect(await expand({ chunk_id: chunk })).toBe("notes/beta.md");
  expect(await expand({ chunk_id: chunk, project_scope: "beta" })).toBe("notes/beta.md");
  await expect(expand({ chunk_id: chunk, project_scope: "alpha" })).rejects.toThrow(
    `chunk not found: ${chunk}`,
  );
});
