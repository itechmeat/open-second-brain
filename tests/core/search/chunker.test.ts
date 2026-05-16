import { test, expect } from "bun:test";
import { chunkMarkdown } from "../../../src/core/search/chunker.ts";

test("empty file yields no chunks but a title from filename", () => {
  const r = chunkMarkdown("", "my_note");
  expect(r.chunks.length).toBe(0);
  expect(r.title).toBe("my note");
});

test("whitespace-only file yields no chunks", () => {
  const r = chunkMarkdown("\n\n   \n", "blank-file");
  expect(r.chunks.length).toBe(0);
});

test("single short paragraph becomes one chunk", () => {
  const r = chunkMarkdown("Hello world.", "doc");
  expect(r.chunks.length).toBe(1);
  expect(r.chunks[0]?.content).toContain("Hello world");
  expect(r.chunks[0]?.startLine).toBe(1);
  expect(r.chunks[0]?.endLine).toBe(1);
  expect(r.chunks[0]?.tokenCount).toBe(2);
});

test("frontmatter becomes synthetic chunk 0 with raw text", () => {
  const text = `---
title: My Title
tags:
  - foo
  - bar
---

# Body H1

Some body paragraph.`;
  const r = chunkMarkdown(text, "ignored");
  expect(r.title).toBe("My Title");
  expect(r.chunks.length).toBeGreaterThanOrEqual(2);
  expect(r.chunks[0]?.content).toContain("title: My Title");
  expect(r.chunks[0]?.content).toContain("tags:");
});

test("malformed frontmatter (no closing ---) is dropped with a warning", () => {
  const text = `---
title: Unterminated

# Body
content here`;
  const r = chunkMarkdown(text, "ignored");
  expect(r.warnings.length).toBe(1);
  expect(r.warnings[0]).toContain("frontmatter");
  // Body still chunked.
  expect(r.chunks.length).toBeGreaterThanOrEqual(1);
});

test("title falls back to first H1 when no frontmatter title", () => {
  const text = `# The Heading

Body.`;
  const r = chunkMarkdown(text, "fallback");
  expect(r.title).toBe("The Heading");
});

test("title falls back to filename when no frontmatter and no H1", () => {
  const r = chunkMarkdown("Just a paragraph.", "my-note_file");
  expect(r.title).toBe("my note file");
});

test("code fence is atomic and not split", () => {
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const text = "Some intro.\n\n```py\n" + long + "\n```\n\nMore prose.";
  const r = chunkMarkdown(text, "doc");
  // Find a chunk containing the opening fence; it should also contain the closing fence.
  const fenceChunks = r.chunks.filter((c) => c.content.includes("```py"));
  expect(fenceChunks.length).toBe(1);
  expect(fenceChunks[0]?.content).toContain("line 0");
  expect(fenceChunks[0]?.content).toContain("line 49");
});

test("oversized code fence becomes its own chunk and is not truncated", () => {
  const huge = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
  const text = "Intro paragraph.\n\n```\n" + huge + "\n```\n\nOutro.";
  const r = chunkMarkdown(text, "doc", { maxTokens: 100, minTokens: 50, overlapTokens: 0 });
  const fenceChunk = r.chunks.find((c) => c.content.includes("word1999"));
  expect(fenceChunk).toBeDefined();
  expect(fenceChunk?.content).toContain("word0");
  expect(fenceChunk?.tokenCount).toBeGreaterThan(100);
});

test("heading attaches to current chunk when below min_tokens", () => {
  const text = `# Tiny

word.

# Next Heading

# Even Next`;
  const r = chunkMarkdown(text, "doc", { maxTokens: 800, minTokens: 100, overlapTokens: 0 });
  // All very small; expect a single chunk.
  expect(r.chunks.length).toBe(1);
  expect(r.chunks[0]?.content).toContain("# Tiny");
  expect(r.chunks[0]?.content).toContain("# Next Heading");
});

test("heading starts a new chunk when current >= min_tokens", () => {
  // Generate a paragraph with >=100 tokens, then a new heading.
  const body = Array.from({ length: 150 }, (_, i) => `w${i}`).join(" ");
  const text = `# A\n\n${body}\n\n# B\n\nmore.`;
  const r = chunkMarkdown(text, "doc", { maxTokens: 800, minTokens: 100, overlapTokens: 0 });
  // Find chunk starting with "# B"
  expect(r.chunks.length).toBeGreaterThanOrEqual(2);
  const second = r.chunks[1]!;
  expect(second.content).toContain("# B");
  expect(second.content).toContain("more");
});

test("list block stays atomic until first non-list line", () => {
  const text = `- one
- two
- three

Next paragraph.`;
  const r = chunkMarkdown(text, "doc", { maxTokens: 100, minTokens: 50, overlapTokens: 0 });
  const listChunk = r.chunks.find((c) => c.content.includes("- one"));
  expect(listChunk?.content).toContain("- three");
});

test("table is captured atomically", () => {
  const text = `| a | b |
|---|---|
| 1 | 2 |
| 3 | 4 |

After table.`;
  const r = chunkMarkdown(text, "doc", { maxTokens: 100, minTokens: 50, overlapTokens: 0 });
  const tableChunk = r.chunks.find((c) => c.content.includes("| a | b |"));
  expect(tableChunk?.content).toContain("| 3 | 4 |");
});

test("UTF-8 Cyrillic content roundtrips and tokenises sensibly", () => {
  const text = `# Привет

Это тестовая строка с кириллицей. Привет, мир!`;
  const r = chunkMarkdown(text, "ru-doc");
  expect(r.chunks.length).toBe(1);
  expect(r.chunks[0]?.content).toContain("Привет");
  expect(r.chunks[0]?.content).toContain("кириллицей");
  expect(r.chunks[0]?.tokenCount).toBeGreaterThan(5);
});

test("overlap prepends previous chunk tail to next", () => {
  // Force two chunks via small maxTokens; verify second begins with overlap.
  const para1 = Array.from({ length: 50 }, (_, i) => `a${i}`).join(" ");
  const para2 = Array.from({ length: 50 }, (_, i) => `b${i}`).join(" ");
  const text = `${para1}\n\n${para2}`;
  const r = chunkMarkdown(text, "doc", { maxTokens: 50, minTokens: 10, overlapTokens: 10 });
  expect(r.chunks.length).toBeGreaterThanOrEqual(2);
  const second = r.chunks[1]!;
  // The second chunk should contain something from a-range (tail) AND the b-range start.
  expect(second.content).toContain("b0");
  expect(/a4\d/.test(second.content)).toBe(true);
});

test("line numbers in chunks point to original (non-overlap) lines", () => {
  const text = `line A
line B
line C

line D
line E`;
  const r = chunkMarkdown(text, "doc", { maxTokens: 4, minTokens: 1, overlapTokens: 0 });
  expect(r.chunks[0]?.startLine).toBe(1);
});
