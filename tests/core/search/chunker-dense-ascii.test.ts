/**
 * Long whitespace-free runs (URLs, file paths, hashes, identifiers) are
 * the Latin-side twin of unspaced scripts: a subword tokenizer spends
 * roughly one token per two to four characters on them, so counting a
 * 3,700-character URL as one "word" let a single chunk thousands of real
 * tokens past the budget, and no `maxTokens` setting could split it,
 * because the splitter only ever cut between lines, sentences or
 * whitespace words (issue #272). The run is now charged about one token
 * per three characters and cut inside itself.
 *
 * Every chunk must also stay small enough to plausibly fit a real model
 * window. Such runs cost about one real tokenizer token per two
 * characters, so the 1,024-character ceiling below holds a chunk under
 * roughly 512 real tokens - asserted with character counts, because the
 * test suite must not download a tokenizer.
 */

import { test, expect } from "bun:test";

import { chunkMarkdown, countChunkTokens } from "../../../src/core/search/chunker.ts";

const URL_LINE = "https://example.invalid/" + "alpha-beta-gamma-delta/".repeat(160);
const DOC = `# Fictional link\n\n${URL_LINE}`;
const URL_ESTIMATED_TOKENS = Math.ceil(URL_LINE.length / 3);

/** The issue's reproducer options for one `maxTokens` value. */
function reproducerOptions(size: number): {
  maxTokens: number;
  minTokens: number;
  overlapTokens: number;
} {
  return { maxTokens: size, minTokens: Math.min(20, size), overlapTokens: 5 };
}

/** Chunk contents with the packer's synthetic line breaks removed. */
function flatChunks(chunks: ReadonlyArray<{ readonly content: string }>): string[] {
  return chunks.map((c) => c.content.replace(/\n/g, ""));
}

for (const size of [80, 40, 20]) {
  test(`the issue reproducer at maxTokens ${size} splits within the cap and the window`, () => {
    const r = chunkMarkdown(DOC, "Fictional link", reproducerOptions(size));
    // The old chunker emitted this document as a single 3,721-character
    // chunk estimated at 4 tokens.
    expect(r.chunks.length).toBeGreaterThan(1);
    for (const c of r.chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(size);
      expect(c.content.length).toBeLessThanOrEqual(1024);
    }
  });
}

test("the split distributes the whole URL, none of it lost", () => {
  for (const size of [80, 40, 20]) {
    const parts = flatChunks(chunkMarkdown(DOC, "Fictional link", reproducerOptions(size)).chunks);
    // Consecutive chunks carry an overlap of at least ten characters, so
    // every ten-character window of the URL falls inside some single
    // chunk rather than straddling a seam.
    for (let i = 0; i < URL_LINE.length; i += 10) {
      const window = URL_LINE.slice(i, i + 10);
      expect(parts.some((p) => p.includes(window))).toBe(true);
    }
  }
});

test("with no overlap the chunks rebuild the document exactly", () => {
  const r = chunkMarkdown(DOC, "doc", { maxTokens: 80, minTokens: 20, overlapTokens: 0 });
  expect(flatChunks(r.chunks).join("")).toBe(DOC.replace(/\n/g, ""));
});

test("splitting one run duplicates no more than the overlap budget", () => {
  const r = chunkMarkdown(DOC, "Fictional link", reproducerOptions(80));
  const carried = flatChunks(r.chunks).reduce((n, c) => n + c.length, 0);
  // An overlap is at most `overlapTokens` estimated tokens, and one
  // estimated token covers at most 15 characters before the dense-run
  // rule applies.
  expect(carried).toBeLessThanOrEqual(DOC.length + r.chunks.length * 5 * 15);
});

test("the estimator charges long runs per character and prose per word", () => {
  // Prose keeps the plain word count, punctuation attached.
  expect(countChunkTokens("The quick brown fox jumps over the lazy dog.")).toBe(9);
  expect(countChunkTokens("responsibility.")).toBe(1);
  // Below the threshold a run is one word; from sixteen characters the
  // run is charged at three characters per token.
  expect(countChunkTokens("abcdefghijklmno")).toBe(1);
  expect(countChunkTokens("abcdefghijklmnop")).toBe(6);
  expect(countChunkTokens(URL_LINE)).toBe(URL_ESTIMATED_TOKENS);
  // Han characters next to a URL charge the URL densely, not the Han.
  expect(countChunkTokens(`索引${URL_LINE}`)).toBe(2 + URL_ESTIMATED_TOKENS);
});

test("a long hash between short prose lines chunks cleanly", () => {
  const hash = "a3f9c2e7".repeat(32);
  const doc =
    "## Sync state\n\nThe manifest pins " +
    hash +
    " as the verified head.\n\nOrdinary prose follows, short words only.";
  const r = chunkMarkdown(doc, "sync", { maxTokens: 60, minTokens: 10, overlapTokens: 0 });
  expect(r.chunks.length).toBeGreaterThan(1);
  for (const c of r.chunks) {
    expect(c.tokenCount).toBeLessThanOrEqual(60);
    expect(c.content.length).toBeLessThanOrEqual(1024);
  }
  expect(flatChunks(r.chunks).join("")).toBe(doc.replace(/\n/g, ""));
});

test("pure Han text chunks exactly as before this change", () => {
  const han = "向量索引把每一篇笔记切成若干片段并分别计算嵌入以便语义检索";
  expect(countChunkTokens(han)).toBe(han.length);
  const long = han.repeat(100);
  const r = chunkMarkdown(long, "zh", { maxTokens: 100, minTokens: 10, overlapTokens: 0 });
  expect(r.chunks.length).toBeGreaterThan(1);
  for (const c of r.chunks) expect(c.tokenCount).toBeLessThanOrEqual(100);
  expect(flatChunks(r.chunks).join("")).toBe(long);
});
