/**
 * Scripts written without spaces between words (Chinese, Japanese,
 * Korean, Thai, Lao, Khmer) must be measured per character, or a whole
 * paragraph counts as one "word" and lands in a single chunk that an
 * embedding provider rejects as oversized (issue #186). And whatever the
 * script, no chunk may exceed `maxTokens` - overlap included.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { test, expect } from "bun:test";

import { chunkMarkdown, type ChunkOptions } from "../../../src/core/search/chunker.ts";
import { CORPUS_OPTION_SETS, spaceSeparatedCorpus } from "../../helpers/chunker-corpus.ts";

const HAN_SENTENCE = "向量索引把每一篇笔记切成若干片段并分别计算嵌入以便语义检索";

/** A single Han paragraph with no whitespace and no line breaks. */
function hanParagraph(chars: number, punctuate: boolean): string {
  let out = "";
  while (out.length < chars) out += HAN_SENTENCE + (punctuate ? "。" : "");
  return out.slice(0, chars);
}

function allWithinCap(text: string, opts: Required<ChunkOptions>): void {
  const r = chunkMarkdown(text, "doc", opts);
  for (const c of r.chunks) {
    expect(c.tokenCount).toBeLessThanOrEqual(opts.maxTokens);
  }
}

/** Every chunk's content, overlap-free, with line breaks removed. */
function bodyText(text: string, opts: ChunkOptions): string {
  return chunkMarkdown(text, "doc", { ...opts, overlapTokens: 0 })
    .chunks.map((c) => c.content)
    .join("")
    .replace(/\n/g, "");
}

test("a 9,004-character Han paragraph is split into chunks within the cap", () => {
  const text = hanParagraph(9004, false);
  const r = chunkMarkdown(text, "zh");
  expect(r.chunks.length).toBeGreaterThan(1);
  for (const c of r.chunks) expect(c.tokenCount).toBeLessThanOrEqual(800);
  // Nothing is lost: the bodies, without overlap, rebuild the paragraph.
  expect(bodyText(text, {})).toBe(text);
});

test("each Han character is measured as its own token", () => {
  const r = chunkMarkdown("索引重建", "zh");
  expect(r.chunks[0]?.tokenCount).toBe(4);
  // Mixed text: the Latin word keeps counting as one word.
  const mixed = chunkMarkdown("使用 sqlite 索引", "zh");
  expect(mixed.chunks[0]?.tokenCount).toBe(1 + 1 + 1 + 2);
});

test("a long Japanese paragraph breaks after sentence punctuation", () => {
  const sentence = "検索索引はノートを小さな断片に分けて埋め込みを計算します。";
  const text = sentence.repeat(120);
  const r = chunkMarkdown(text, "ja", { maxTokens: 200, minTokens: 50, overlapTokens: 0 });
  expect(r.chunks.length).toBeGreaterThan(1);
  for (const c of r.chunks) {
    expect(c.tokenCount).toBeLessThanOrEqual(200);
    expect(c.content.endsWith("。")).toBe(true);
  }
});

test("astral-plane Han characters count once each and are never split", () => {
  // CJK Extension B lives above U+FFFF: two UTF-16 code units per character.
  let text = "";
  for (let i = 0; i < 3000; i++) text += String.fromCodePoint(0x20000 + (i % 500));
  const r = chunkMarkdown(text, "ext-b", { maxTokens: 100, minTokens: 10, overlapTokens: 30 });
  expect(r.chunks.length).toBeGreaterThan(1);
  for (const c of r.chunks) {
    expect(c.tokenCount).toBeLessThanOrEqual(100);
    // No lone surrogate at either end of a chunk.
    expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c.content)).toBe(false);
    expect([...c.content.replace(/\n/g, "")].length).toBe(c.tokenCount);
  }
  expect(bodyText(text, { maxTokens: 100, minTokens: 10 })).toBe(text);
});

test("Thai combining marks stay with the character they modify", () => {
  const word = "ภาษาไทยไม่เว้นวรรคระหว่างคำที่เขียนต่อกัน";
  const text = word.repeat(200);
  const r = chunkMarkdown(text, "th", { maxTokens: 64, minTokens: 8, overlapTokens: 16 });
  expect(r.chunks.length).toBeGreaterThan(1);
  for (const c of r.chunks) {
    expect(c.tokenCount).toBeLessThanOrEqual(64);
    for (const line of c.content.split("\n")) expect(/^\p{M}/u.test(line)).toBe(false);
  }
});

test("Cyrillic and other spaced scripts keep counting words, not letters", () => {
  const text = "Это тестовая строка с кириллицей. Ελληνικά κείμενα επίσης. مرحبا بالعالم";
  const r = chunkMarkdown(text, "mixed");
  expect(r.chunks[0]?.tokenCount).toBe(text.split(" ").length);
  // A long Cyrillic note is not fragmented letter by letter.
  const long = Array.from({ length: 400 }, (_, i) => `слово${i}`).join(" ");
  const chunks = chunkMarkdown(long, "ru", { maxTokens: 800, minTokens: 100, overlapTokens: 100 });
  expect(chunks.chunks.length).toBe(1);
  expect(chunks.chunks[0]?.tokenCount).toBe(400);
});

// ── the cap invariant ────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  () => hanParagraph(40, true),
  () => "検索索引はノートを断片に分けます。",
  () => "한국어 문장은 띄어쓰기를 사용합니다.",
  () => "ภาษาไทยไม่เว้นวรรค",
  () => String.fromCodePoint(0x20000, 0x2a6d6, 0x2b740),
  () => "the quick brown fox jumps over the lazy dog",
  () => "Привет мир, это заметка",
  () => "emoji 🙂👍🏽 and café",
];

/** A deterministic mixed-script document: headings, lists, code, one-line walls. */
function generatedDocument(seed: number): string {
  const rand = mulberry32(seed);
  const pick = () => PIECES[Math.floor(rand() * PIECES.length)]!();
  const blocks: string[] = [];
  if (seed % 3 === 0)
    blocks.push(
      `---\ntitle: ${pick()}\nsummary: ${Array.from({ length: 60 }, pick).join("")}\n---`,
    );
  const count = 3 + Math.floor(rand() * 12);
  for (let b = 0; b < count; b++) {
    const kind = rand();
    const len = 1 + Math.floor(rand() * (rand() < 0.3 ? 300 : 20));
    const run = () => Array.from({ length: len }, pick).join(rand() < 0.5 ? "" : " ");
    if (kind < 0.15) blocks.push(`## ${run().slice(0, 400)}`);
    else if (kind < 0.3)
      blocks.push(Array.from({ length: 1 + (len % 6) }, () => `- ${run()}`).join("\n"));
    else if (kind < 0.4) blocks.push("```\n" + run() + "\n" + run() + "\n```");
    else blocks.push(Array.from({ length: 1 + (len % 4) }, run).join("\n"));
  }
  return blocks.join("\n\n");
}

for (const overlapTokens of [0, 100]) {
  test(`no chunk exceeds maxTokens (overlap ${overlapTokens}) over generated mixed-script documents`, () => {
    for (let seed = 1; seed <= 40; seed++) {
      const text = generatedDocument(seed);
      allWithinCap(text, { maxTokens: 800, minTokens: 100, overlapTokens });
      allWithinCap(text, {
        maxTokens: 150,
        minTokens: 20,
        overlapTokens: Math.min(overlapTokens, 60),
      });
    }
  });
}

test("overlap alone never pushes a chunk over the cap", () => {
  // Long single-line paragraphs: the old overlap took a whole line "whatever
  // it costs" and prepended it, so the next chunk started over budget.
  const line = Array.from({ length: 700 }, (_, i) => `w${i}`).join(" ");
  const text = `${line}\n\n${line}\n\n${line}`;
  allWithinCap(text, { maxTokens: 800, minTokens: 100, overlapTokens: 100 });
  const r = chunkMarkdown(text, "doc", { maxTokens: 800, minTokens: 100, overlapTokens: 100 });
  // Overlap is still carried, just bounded: chunk two opens with the tail of chunk one.
  expect(r.chunks[1]?.content.startsWith("w600 ")).toBe(true);
});

// ── the space-separated path is unchanged ────────────────────────────────

interface BaselineEntry {
  readonly options: number;
  readonly doc: number;
  readonly withinCap: boolean;
  readonly digest: string;
}

test("space-separated notes chunk exactly as before the fix", () => {
  const baseline = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../fixtures/chunker/space-separated-baseline.json"),
      "utf8",
    ),
  ) as { entries: BaselineEntry[] };
  const corpus = spaceSeparatedCorpus();
  let pinned = 0;
  for (const e of baseline.entries) {
    const opts = CORPUS_OPTION_SETS[e.options]!;
    const r = chunkMarkdown(corpus[e.doc]!, `note-${e.doc}`, opts);
    const digest = createHash("sha256").update(JSON.stringify(r.chunks)).digest("hex");
    if (e.withinCap) {
      // Output that already respected the cap is byte-identical, hashes and all.
      expect({ doc: e.doc, options: e.options, digest }).toEqual({
        doc: e.doc,
        options: e.options,
        digest: e.digest,
      });
      pinned++;
    } else {
      // Output that broke the cap changes, and now respects it.
      for (const c of r.chunks) expect(c.tokenCount).toBeLessThanOrEqual(opts.maxTokens);
    }
  }
  expect(pinned).toBeGreaterThan(50);
});
