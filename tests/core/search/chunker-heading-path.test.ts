/**
 * Header-anchored chunking: each chunk carries the breadcrumb of the
 * headings in effect at its start ("Top > Section A"), so a mid-document
 * chunk that split off from its section still records its topical
 * anchor. The breadcrumb is metadata - it never appears in the chunk's
 * display content.
 */

import { test, expect } from "bun:test";

import { chunkMarkdown } from "../../../src/core/search/chunker.ts";

test("chunks carry the ancestor heading breadcrumb", () => {
  const md = [
    "# Top",
    "",
    "Intro paragraph under the top heading.",
    "",
    "## Section A",
    "",
    "Body text that lives under section A and should be anchored.",
    "",
    "## Section B",
    "",
    "Different body under section B.",
  ].join("\n");

  // Small token budget forces each section to split into its own chunk
  // so a body chunk is anchored by its heading rather than swallowing
  // the whole document into one chunk.
  const { chunks } = chunkMarkdown(md, "doc", { maxTokens: 8, minTokens: 1, overlapTokens: 0 });
  expect(chunks.length).toBeGreaterThan(0);
  for (const c of chunks) {
    expect(typeof c.headingPath).toBe("string");
  }
  // The chunk containing Section A body is anchored under Top > Section A.
  const aChunk = chunks.find((c) => c.content.includes("under section A"));
  expect(aChunk).toBeDefined();
  expect(aChunk!.headingPath).toBe("Top > Section A");
  // Section B body is anchored under Top > Section B.
  const bChunk = chunks.find((c) => c.content.includes("under section B"));
  expect(bChunk!.headingPath).toBe("Top > Section B");
});

test("a document with no headings yields an empty breadcrumb", () => {
  const { chunks } = chunkMarkdown("Just a flat paragraph with no headings at all.", "flat");
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]!.headingPath).toBe("");
});

test("breadcrumb pops to the correct level when heading depth decreases", () => {
  const md = [
    "# Root",
    "",
    "## Child",
    "",
    "### Grandchild",
    "",
    "deep content here",
    "",
    "## Sibling",
    "",
    "sibling content here",
  ].join("\n");
  const { chunks } = chunkMarkdown(md, "doc", { maxTokens: 8, minTokens: 1, overlapTokens: 0 });
  const deep = chunks.find((c) => c.content.includes("deep content"));
  expect(deep!.headingPath).toBe("Root > Child > Grandchild");
  const sibling = chunks.find((c) => c.content.includes("sibling content"));
  // The deeper "Grandchild" must have been popped when "## Sibling" opened.
  expect(sibling!.headingPath).toBe("Root > Sibling");
});
