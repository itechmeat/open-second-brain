/**
 * `brain_search` never opens its `content` window inside a surrogate pair
 * (what-the-index-already-knew, task E follow-up).
 *
 * The MCP window slices UTF-16 units at a start that anchoring moved off
 * zero. When that start lands on the LOW half of a surrogate pair the
 * payload begins with a lone surrogate, which the JSON-RPC frame's UTF-8
 * encoding turns into U+FFFD - the caller reads a replacement character
 * where an emoji was. The hazard is new: before anchoring, the start was
 * always zero.
 *
 * The head window must stay byte-identical to the pre-anchoring head
 * truncation, and that is asserted against bytes recomputed from the
 * stored chunk rather than read back from the surface under test. That
 * expectation deliberately still carries the TRAILING cut's own
 * surrogate split: the tail has always cut on a raw UTF-16 offset, the
 * bytes it produces are the pre-change contract, and this wave does not
 * change them.
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
/** Mirrors `ELLIPSIS` in `src/core/search/snippet-window.ts`. */
const ELLIPSIS = "…";
/** Chunk cap for the fixture vault: the whole passage stays one chunk. */
const FIXTURE_CHUNK_SIZE = 4000;

/** Occurs at offset 0, so a query for it anchors the window at the head. */
const HEAD_TERM = "prelude";
const ANCHOR_TERM = "entanglement";
const EMOJI = "\u{1F600}";
const REPLACEMENT_CHAR = "�";
const NOTE_PATH = "notes/emoji.md";

/**
 * `prelude ` (8 units), 400 emoji (800 units), a space, then the anchor
 * term at offset 809. The unaligned window start is 809 - 300 = 509, the
 * low half of an emoji. The trailing run keeps the chunk over the cap.
 */
const BODY = `${HEAD_TERM} ${EMOJI.repeat(400)} ${ANCHOR_TERM}${" tail".repeat(40)}`;

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
  const row = outcome.results.find((r) => r.path === NOTE_PATH);
  expect(row).toBeDefined();
  return row!.content;
}

async function contentFor(query: string): Promise<string> {
  const out = await runSearch(query);
  const row = out.results.find((r) => r.path === NOTE_PATH);
  expect(row).toBeDefined();
  return row!.content;
}

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-window-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-window-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nsearch_chunk_size: ${FIXTURE_CHUNK_SIZE}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, NOTE_PATH), `---\ntitle: Emoji\n---\n\n${BODY}\n`);
  ctx = { vault, configPath };
  await indexVault(resolveSearchConfig({ vault, configPath }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search content window boundaries", () => {
  test("the fixture really does anchor the window inside a surrogate pair", async () => {
    const chunk = await storedChunk(ANCHOR_TERM);
    expect(chunk.length).toBeGreaterThan(MCP_CONTENT_MAX);
    const unaligned = chunk.indexOf(ANCHOR_TERM) - Math.floor(MCP_CONTENT_MAX / 2);
    const unit = chunk.charCodeAt(unaligned);
    expect(unit).toBeGreaterThanOrEqual(0xdc00);
    expect(unit).toBeLessThanOrEqual(0xdfff);
  });

  test("the returned window survives a UTF-8 round trip with no replacement char", async () => {
    const content = await contentFor(ANCHOR_TERM);
    // The window opens on a whole emoji, so nothing at the HEAD degrades.
    expect(content.startsWith(`${ELLIPSIS}${EMOJI}`)).toBe(true);
    const roundTripped = new TextDecoder().decode(new TextEncoder().encode(content));
    expect(roundTripped).not.toContain(REPLACEMENT_CHAR);
    expect(content).toContain(ANCHOR_TERM);
    expect(content.length).toBeLessThanOrEqual(MCP_CONTENT_MAX);
  });

  test("a head-anchored window is the pre-change head truncation, byte for byte", async () => {
    const chunk = await storedChunk(HEAD_TERM);
    const expected =
      chunk.length <= MCP_CONTENT_MAX
        ? chunk
        : `${chunk.slice(0, MCP_CONTENT_MAX - ELLIPSIS.length)}${ELLIPSIS}`;
    expect(await contentFor(HEAD_TERM)).toBe(expected);
  });
});
