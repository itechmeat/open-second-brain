/**
 * `brain_search` serializes the merged-away duplicate locations
 * (what-the-index-already-knew, task D landed the merge, task E landed
 * the boundary).
 *
 * The exact-duplicate merge folds a byte-identical passage into the
 * higher-ranked row and records every location it was folded from on
 * `BrainSearchResult.duplicates`. The MCP projection is an explicit field
 * whitelist, so that value was computed end-to-end and dropped at the
 * boundary - the caller saw one row and no way to learn the same bytes
 * live at three paths.
 *
 * House discipline for an optional field: ABSENT, not null, when nothing
 * was merged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

/** The passage duplicated verbatim across files below. */
const PASSAGE =
  "# Quantum entanglement\n\n" +
  "Quantum entanglement links two particles so that measuring one fixes " +
  "the other, regardless of the distance separating them. The correlation " +
  "is not a signal and carries no information on its own.\n";

interface DuplicateLocation {
  documentId: number;
  chunkId: number;
  path: string;
  title: string | null;
  startLine: number;
  endLine: number;
}

interface SearchOut {
  results: Array<Record<string, unknown> & { path: string; duplicates?: DuplicateLocation[] }>;
  total: number;
}

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

const tool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

function writeNote(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

async function reindex(): Promise<void> {
  await indexVault(resolveSearchConfig({ vault, configPath: ctx.configPath }), {});
}

async function runSearch(query: string): Promise<SearchOut> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool().handler(ctx as any, { query })) as SearchOut;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dup-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dup-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  ctx = { vault, configPath };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search duplicate locations", () => {
  test("a merged row names every location the passage was folded from", async () => {
    writeNote("physics/entanglement.md", PASSAGE);
    writeNote("archive/entanglement-copy.md", PASSAGE);
    await reindex();

    const out = await runSearch("quantum entanglement");
    expect(out.results.length).toBe(1);
    const row = out.results[0]!;
    expect(row.duplicates).toBeDefined();
    expect(row.duplicates!.length).toBe(1);
    const named = [row.path, ...row.duplicates!.map((d) => d.path)].toSorted();
    expect(named).toEqual(["archive/entanglement-copy.md", "physics/entanglement.md"]);
    const folded = row.duplicates![0]!;
    expect(typeof folded.documentId).toBe("number");
    expect(typeof folded.chunkId).toBe("number");
    expect(folded.startLine).toBeGreaterThan(0);
    expect(folded.endLine).toBeGreaterThanOrEqual(folded.startLine);
  });

  test("no duplicates key at all when nothing was merged", async () => {
    writeNote("one.md", "# Alpha\n\nQuantum alpha notes about the first topic entirely.\n");
    writeNote("two.md", "# Beta\n\nQuantum beta notes about the second topic entirely.\n");
    await reindex();

    const out = await runSearch("quantum notes");
    expect(out.results.length).toBe(2);
    for (const row of out.results) {
      expect("duplicates" in row).toBe(false);
    }
  });
});
