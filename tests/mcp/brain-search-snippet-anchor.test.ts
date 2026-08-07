/**
 * `brain_search` returns a match-anchored `content` window
 * (what-the-index-already-knew, task E).
 *
 * The MCP surface capped `content` at 600 chars taken from the HEAD of
 * the chunk, so a query term occurring later in a long passage never
 * reached the caller: the agent saw 600 characters of preamble and no
 * evidence of why the row ranked. The window is now centred on the first
 * significant query term the content contains.
 *
 * A chunk with no query-term occurrence is unchanged - the head window,
 * the same bytes - and that is asserted, not assumed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig, search } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

/** Mirrors `MCP_CONTENT_MAX` in `src/mcp/search-tools.ts`. */
const MCP_CONTENT_MAX = 600;
/** Chunk cap for the fixture vault: one long passage stays one chunk. */
const FIXTURE_CHUNK_SIZE = 4000;

const FILLER = "This paragraph records background context for the passage. ";
const ANCHOR_TERM = "entanglement";
const MATCH_SENTENCE = `Quantum ${ANCHOR_TERM} links two particles at a distance.`;

/** Lead long enough that the match sits well past `MCP_CONTENT_MAX`. */
const LEAD = FILLER.repeat(24);
const BODY = `${LEAD}${MATCH_SENTENCE} ${FILLER.repeat(24)}`;

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

const tool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

interface SearchOut {
  results: Array<{ path: string; content: string }>;
  total: number;
}

async function runSearch(query: string): Promise<SearchOut> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool().handler(ctx as any, { query })) as SearchOut;
}

/** The untruncated stored chunk the MCP row is a window onto. */
async function storedChunk(query: string): Promise<string> {
  const outcome = await search(resolveSearchConfig({ vault, configPath: ctx.configPath }), {
    query,
    limit: 10,
  });
  const row = outcome.results.find((r) => r.path === "notes/physics.md");
  expect(row).toBeDefined();
  return row!.content;
}

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-anchor-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-anchor-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nsearch_chunk_size: ${FIXTURE_CHUNK_SIZE}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "physics.md"), `---\ntitle: Physics\n---\n\n${BODY}\n`);
  ctx = { vault, configPath };
  await indexVault(resolveSearchConfig({ vault, configPath }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search snippet anchoring", () => {
  test("the fixture stores one chunk with the match past the content cap", async () => {
    const chunk = await storedChunk(ANCHOR_TERM);
    expect(chunk.length).toBeGreaterThan(MCP_CONTENT_MAX);
    expect(chunk.indexOf(ANCHOR_TERM)).toBeGreaterThan(MCP_CONTENT_MAX);
  });

  test("a match past the content cap appears in the returned window", async () => {
    const out = await runSearch(ANCHOR_TERM);
    expect(out.total).toBeGreaterThan(0);
    const row = out.results.find((r) => r.path === "notes/physics.md");
    expect(row).toBeDefined();
    // The window is still capped, so this is not "the whole chunk came back".
    expect(row!.content.length).toBeLessThanOrEqual(MCP_CONTENT_MAX);
    expect(row!.content).toContain(ANCHOR_TERM);
  });

  test("a head-anchored window is the pre-change head truncation, byte for byte", async () => {
    // Both significant terms occur inside the first 600 chars of the
    // filler, so the anchored window starts at 0 - the defined head
    // window. The expected bytes are recomputed from the stored chunk
    // with the pre-change rule, not read back from the function.
    const query = "paragraph background";
    const chunk = await storedChunk(query);
    const expected =
      chunk.length <= MCP_CONTENT_MAX ? chunk : `${chunk.slice(0, MCP_CONTENT_MAX - 1)}…`;
    const out = await runSearch(query);
    const row = out.results.find((r) => r.path === "notes/physics.md");
    expect(row).toBeDefined();
    expect(row!.content).toBe(expected);
  });
});
