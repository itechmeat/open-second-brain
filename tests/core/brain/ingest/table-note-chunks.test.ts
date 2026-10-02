/**
 * A rendered table note through the real chunker (design T2): row groups
 * are bounded by the chunker's own token counter, so every chunk that holds
 * table rows also holds the header record and a `Table > Rows a-b` heading
 * path, with no change to the chunking rules.
 */

import { describe, expect, test } from "bun:test";

import {
  tableNote,
  TABLE_NOTE_GROUP_MAX_TOKENS,
} from "../../../../src/core/brain/ingest/table-note.ts";
import {
  chunkMarkdown,
  countChunkTokens,
  DEFAULT_CHUNK_MAX_TOKENS,
} from "../../../../src/core/search/chunker.ts";

const COLUMNS = 15;
const ROWS = 400;

/** Row 4's first cell opens with a backtick run, the way a pasted code sample would. */
const FENCE_LIKE_ROW = 4;

function wideCsv(fenceLikeRow?: number): Uint8Array {
  const header = Array.from({ length: COLUMNS }, (_, c) => `field ${c + 1}`);
  const rows = Array.from({ length: ROWS }, (_row, r) =>
    Array.from({ length: COLUMNS }, (_column, c) =>
      r + 1 === fenceLikeRow && c === 0 ? "```js" : `value ${r + 1} ${c + 1}`,
    ),
  );
  return new TextEncoder().encode([header, ...rows].map((r) => r.join(",")).join("\n"));
}

describe("table note chunks", () => {
  test("the group budget fits one chunk with room for the chunker's own overlap", () => {
    expect(TABLE_NOTE_GROUP_MAX_TOKENS).toBeLessThan(DEFAULT_CHUNK_MAX_TOKENS);
    expect(countChunkTokens("")).toBe(0);
  });

  test("every chunk holding rows carries the header line and a Rows heading path", () => {
    const result = tableNote("Clips/wide.csv", wideCsv());
    if (!result.rendered) throw new Error(`not rendered: ${result.reason}`);
    expect(result.rowsRendered).toBe(ROWS);
    const headerLine = Array.from({ length: COLUMNS }, (_, c) => `field ${c + 1}`).join(" | ");
    const page = `# Wide export\n\nA summary.\n\n${result.section}\n`;

    const { chunks } = chunkMarkdown(page, "wide");
    const rowChunks = chunks.filter((chunk) => /^value \d+ 1 \|/m.test(chunk.content));
    expect(rowChunks.length).toBeGreaterThan(1);

    const seen = new Set<number>();
    for (const chunk of rowChunks) {
      expect(chunk.content.split("\n")).toContain(headerLine);
      expect(chunk.headingPath).toMatch(/Table > Rows \d+-\d+$/);
      for (const match of chunk.content.matchAll(/^value (\d+) 1 \|/gm)) seen.add(Number(match[1]));
    }
    expect(seen.size).toBe(ROWS);
  });

  test("a cell that opens with a backtick run keeps one Rows heading path per group", () => {
    const result = tableNote("Clips/wide.csv", wideCsv(FENCE_LIKE_ROW));
    if (!result.rendered) throw new Error(`not rendered: ${result.reason}`);
    const groups = [...result.section.matchAll(/^### (Rows \d+-\d+)$/gm)].map((m) => m[1]!);
    expect(groups.length).toBeGreaterThan(1);

    const { chunks } = chunkMarkdown(`# T\n\n${result.section}\n`, "wide");
    const paths = new Set(
      chunks
        .map((chunk) => /Table > (Rows \d+-\d+)$/.exec(chunk.headingPath)?.[1])
        .filter((path) => path !== undefined),
    );
    expect([...paths]).toEqual(groups);
  });
});
