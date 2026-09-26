/**
 * Markdown chunker — two-pass structural split + token-budget packer.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §6.
 *
 * Token approximation: whitespace word count, except for scripts written
 * without spaces between words (Han, Hiragana, Katakana, Hangul, Bopomofo,
 * Thai, Lao, Khmer, CJK punctuation and fullwidth forms), where every
 * character is one token - a paragraph of Chinese has no whitespace, and
 * counting it as one "word" sent 9,000-character chunks to providers that
 * reject them (issue #186). Deterministic across Bun/Node,
 * dependency-free, machine-independent — so the same vault hashes the
 * same chunks on every Syncthing peer.
 *
 * Budget invariant: every chunk's `tokenCount`, overlap included, is at
 * most `maxTokens`. A block too large for one chunk is split by line, then
 * after sentence punctuation, then at a token boundary.
 */

/**
 * Version of the chunking rules. Chunks are only recomputed when a file
 * changes, so a change to how the SAME text is chunked must bump this: the
 * indexer compares it with the value an index recorded and re-chunks every
 * document once when they differ.
 *
 *   1 - whitespace word count, overlap outside the budget (through v1.57).
 *   2 - per-character count for unspaced scripts; overlap inside the
 *       budget; oversize blocks split (issue #186).
 */
export const CHUNKER_VERSION = 2;

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_MIN_TOKENS = 100;
const DEFAULT_OVERLAP_TOKENS = 100;

export interface ChunkOptions {
  readonly maxTokens?: number;
  readonly minTokens?: number;
  readonly overlapTokens?: number;
}

export interface MarkdownChunk {
  readonly chunkIndex: number;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly tokenCount: number;
  /**
   * Breadcrumb of headings the chunk falls under, joined by " > "
   * (e.g. "Top > Section A"). Computed at the chunk's end so a chunk
   * spanning into a deeper subsection is anchored to the deepest
   * heading it covers. Empty when no heading precedes the chunk.
   * Indexed in a dedicated FTS column so a mid-document chunk keeps its
   * topical anchor; never part of the display content.
   */
  readonly headingPath: string;
}

export interface ChunkResult {
  readonly title: string | null;
  readonly chunks: ReadonlyArray<MarkdownChunk>;
  readonly warnings: ReadonlyArray<string>;
}

interface Line {
  readonly num: number;
  readonly text: string;
}

type BlockKind = "frontmatter" | "code" | "heading" | "list" | "table" | "paragraph";

interface Block {
  readonly kind: BlockKind;
  readonly lines: ReadonlyArray<Line>;
  readonly tokenCount: number;
}

/**
 * A character of a script written without spaces between words, plus CJK
 * punctuation (U+3000-303F) and halfwidth/fullwidth forms (U+FF00-FFEF).
 * Sticky, so it tests the code point AT `lastIndex` without allocating.
 * Cyrillic, Greek, Arabic and every other spaced script is deliberately
 * absent: those keep the word count.
 */
const UNSPACED_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}　-〿＀-￯]/uy;

/** A combining mark (Thai vowel signs, the kana voicing marks, ...). */
const MARK_RE = /\p{M}/uy;

/** Every unspaced-script code point is at or above Thai (U+0E00). */
const FIRST_UNSPACED_CODE_POINT = 0x0e00;

function matchesAt(re: RegExp, text: string, i: number): boolean {
  re.lastIndex = i;
  return re.test(text);
}

/**
 * Walk `text`'s tokens: a run of non-whitespace is one token, except that
 * each unspaced-script character is a token of its own (a combining mark
 * after one stays part of it). Pushes each token's start offset onto
 * `starts` when given; returns the count.
 *
 * Whitespace is exactly space, tab, LF and CR, as it always was: text
 * with no unspaced-script character counts exactly as before.
 */
function walkTokens(text: string, starts: number[] | null): number {
  let count = 0;
  let inWord = false;
  let afterUnspaced = false;
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (c < FIRST_UNSPACED_CODE_POINT) {
      const isSpace = c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
      if (isSpace) {
        inWord = false;
        afterUnspaced = false;
        i++;
        continue;
      }
      if (afterUnspaced && c >= 0x0300 && matchesAt(MARK_RE, text, i)) {
        i++;
        continue;
      }
      if (!inWord) {
        count++;
        starts?.push(i);
        inWord = true;
      }
      afterUnspaced = false;
      i++;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (afterUnspaced && matchesAt(MARK_RE, text, i)) {
      // Stays with the character it modifies.
    } else if (matchesAt(UNSPACED_RE, text, i)) {
      count++;
      starts?.push(i);
      inWord = false;
      afterUnspaced = true;
    } else {
      if (!inWord) {
        count++;
        starts?.push(i);
        inWord = true;
      }
      afterUnspaced = false;
    }
    i += width;
  }
  return count;
}

function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return walkTokens(text, null);
}

/** UTF-16 offset of every token start in `text`, in order. */
function tokenStarts(text: string): number[] {
  const starts: number[] = [];
  walkTokens(text, starts);
  return starts;
}

/** The longest suffix of `text` holding at most `budget` tokens. */
function tailTokens(text: string, budget: number): string {
  if (budget <= 0) return "";
  const starts = tokenStarts(text);
  if (starts.length <= budget) return text;
  return text.slice(starts[starts.length - budget]);
}

function tokensOfLines(lines: ReadonlyArray<Line>): number {
  let total = 0;
  for (const l of lines) total += countTokens(l.text);
  return total;
}

function makeBlock(kind: BlockKind, lines: Line[]): Block {
  return { kind, lines, tokenCount: tokensOfLines(lines) };
}

function isBlank(s: string): boolean {
  return s.trim() === "";
}

const FENCE_RE = /^(?:```|~~~)/;
const HEADING_RE = /^#{1,6}\s/;
const LIST_ITEM_RE = /^\s*(?:[-*+]\s|\d+\.\s)/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** Split the raw text into a 1-indexed line array. */
function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let lineNum = 1;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a /* \n */) {
      const seg = text.slice(start, i);
      const cleaned = seg.endsWith("\r") ? seg.slice(0, -1) : seg;
      out.push({ num: lineNum++, text: cleaned });
      start = i + 1;
    }
  }
  if (start <= text.length) {
    const seg = text.slice(start);
    if (seg !== "" || out.length === 0) {
      const cleaned = seg.endsWith("\r") ? seg.slice(0, -1) : seg;
      out.push({ num: lineNum, text: cleaned });
    }
  }
  return out;
}

function extractFrontmatter(lines: ReadonlyArray<Line>): {
  block: Block | null;
  remaining: ReadonlyArray<Line>;
  warnings: string[];
} {
  if (lines.length === 0 || lines[0]!.text.trim() !== "---") {
    return { block: null, remaining: lines, warnings: [] };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.text.trim() === "---") {
      const fmLines = lines.slice(0, i + 1);
      return {
        block: makeBlock("frontmatter", [...fmLines]),
        remaining: lines.slice(i + 1),
        warnings: [],
      };
    }
  }
  // Unterminated frontmatter: omit FM block, keep file otherwise indexable.
  return {
    block: null,
    remaining: lines.slice(1),
    warnings: ["malformed frontmatter (no closing '---')"],
  };
}

function readCodeBlock(lines: ReadonlyArray<Line>, start: number): { end: number } {
  // `lines[start]` is the opening fence.
  const fenceText = lines[start]!.text.trim();
  const fenceMark = fenceText.startsWith("```") ? "```" : "~~~";
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.text.trim().startsWith(fenceMark)) return { end: i };
  }
  return { end: lines.length - 1 }; // unclosed: run to EOF
}

function readList(lines: ReadonlyArray<Line>, start: number): { end: number } {
  let i = start + 1;
  while (i < lines.length) {
    const t = lines[i]!.text;
    if (isBlank(t)) return { end: i - 1 };
    if (HEADING_RE.test(t)) return { end: i - 1 };
    if (FENCE_RE.test(t)) return { end: i - 1 };
    // Continuation of list: list item or indented continuation.
    if (LIST_ITEM_RE.test(t) || /^\s{2,}/.test(t)) {
      i++;
      continue;
    }
    return { end: i - 1 };
  }
  return { end: lines.length - 1 };
}

function isTableStart(lines: ReadonlyArray<Line>, start: number): boolean {
  const a = lines[start];
  const b = lines[start + 1];
  if (!a || !b) return false;
  if (!a.text.includes("|")) return false;
  return TABLE_SEP_RE.test(b.text);
}

function readTable(lines: ReadonlyArray<Line>, start: number): { end: number } {
  // Header (start), separator (start+1), then rows until blank or non-pipe line.
  let i = start + 2;
  while (i < lines.length) {
    const t = lines[i]!.text;
    if (isBlank(t)) return { end: i - 1 };
    if (!t.includes("|")) return { end: i - 1 };
    i++;
  }
  return { end: lines.length - 1 };
}

function readParagraph(lines: ReadonlyArray<Line>, start: number): { end: number } {
  let i = start + 1;
  while (i < lines.length) {
    const t = lines[i]!.text;
    if (isBlank(t)) return { end: i - 1 };
    if (HEADING_RE.test(t)) return { end: i - 1 };
    if (FENCE_RE.test(t)) return { end: i - 1 };
    if (LIST_ITEM_RE.test(t)) return { end: i - 1 };
    if (isTableStart(lines, i)) return { end: i - 1 };
    i++;
  }
  return { end: lines.length - 1 };
}

function splitIntoBlocks(lines: ReadonlyArray<Line>): { blocks: Block[]; warnings: string[] } {
  const blocks: Block[] = [];
  const warnings: string[] = [];
  const { block: fm, remaining, warnings: fmWarn } = extractFrontmatter(lines);
  warnings.push(...fmWarn);
  if (fm) blocks.push(fm);

  let i = 0;
  while (i < remaining.length) {
    const text = remaining[i]!.text;
    if (isBlank(text)) {
      i++;
      continue;
    }
    if (FENCE_RE.test(text)) {
      const { end } = readCodeBlock(remaining, i);
      blocks.push(makeBlock("code", remaining.slice(i, end + 1)));
      i = end + 1;
      continue;
    }
    if (HEADING_RE.test(text)) {
      blocks.push(makeBlock("heading", [remaining[i]!]));
      i++;
      continue;
    }
    if (LIST_ITEM_RE.test(text)) {
      const { end } = readList(remaining, i);
      blocks.push(makeBlock("list", remaining.slice(i, end + 1)));
      i = end + 1;
      continue;
    }
    if (isTableStart(remaining, i)) {
      const { end } = readTable(remaining, i);
      blocks.push(makeBlock("table", remaining.slice(i, end + 1)));
      i = end + 1;
      continue;
    }
    const { end } = readParagraph(remaining, i);
    blocks.push(makeBlock("paragraph", remaining.slice(i, end + 1)));
    i = end + 1;
  }

  return { blocks, warnings };
}

interface DraftChunk {
  blocks: Block[];
  tokens: number;
}

function newDraft(): DraftChunk {
  return { blocks: [], tokens: 0 };
}

/**
 * The tail of `lines` holding at most `budget` tokens, in order. Whole
 * lines are taken from the end while they fit; when not even the last line
 * fits, its own tail is taken, cut at a token boundary - so a dense
 * document still carries overlap, and the overlap never costs more than
 * its budget.
 */
function tailLines(lines: ReadonlyArray<Line>, budget: number): Line[] {
  if (budget <= 0) return [];
  let acc = 0;
  const tail: Line[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const t = countTokens(line.text);
    if (acc + t > budget) {
      if (tail.length === 0) {
        const cut = tailTokens(line.text, budget);
        if (cut !== "") tail.unshift({ num: line.num, text: cut });
      }
      break;
    }
    tail.unshift(line);
    acc += t;
  }
  return tail;
}

function takeOverlap(prev: DraftChunk, overlapTokens: number): Line[] {
  if (overlapTokens <= 0 || prev.blocks.length === 0) return [];
  const allLines: Line[] = [];
  for (const b of prev.blocks) for (const l of b.lines) allLines.push(l);
  return tailLines(allLines, overlapTokens);
}

function emitChunk(
  index: number,
  overlap: ReadonlyArray<Line>,
  draft: DraftChunk,
  maxTokens: number,
): MarkdownChunk {
  const bodyLines: Line[] = [];
  for (const b of draft.blocks) for (const l of b.lines) bodyLines.push(l);
  // The packer leaves room for the overlap; this only bites when the
  // configured overlap is larger than a chunk can spare.
  const fitted =
    tokensOfLines(overlap) + draft.tokens > maxTokens
      ? tailLines(overlap, maxTokens - draft.tokens)
      : overlap;
  const allText = [...fitted.map((l) => l.text), ...bodyLines.map((l) => l.text)].join("\n");
  const tokenCount = countTokens(allText);
  return Object.freeze({
    chunkIndex: index,
    content: allText,
    startLine: bodyLines[0]?.num ?? fitted[0]?.num ?? 1,
    endLine: bodyLines[bodyLines.length - 1]?.num ?? fitted[fitted.length - 1]?.num ?? 1,
    tokenCount,
    headingPath: "",
  });
}

/**
 * Sentence-final punctuation of the unspaced scripts. Each is a token of
 * its own, so a cut right after one is a token boundary.
 */
const SENTENCE_ENDS: ReadonlySet<string> = new Set(["。", "！", "？", "；", "｡", "．"]);

/** Closing quotes and brackets that belong to the sentence before them. */
const SENTENCE_CLOSERS: ReadonlySet<string> = new Set([
  "」",
  "』",
  "）",
  "】",
  "〕",
  "》",
  "〉",
  "”",
  "’",
]);

/** `text` cut after each sentence end (and its closing quotes). Concatenates back to `text`. */
function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    i += ch.length;
    if (!SENTENCE_ENDS.has(ch)) continue;
    while (i < text.length) {
      const next = String.fromCodePoint(text.codePointAt(i)!);
      if (!SENTENCE_ENDS.has(next) && !SENTENCE_CLOSERS.has(next)) break;
      i += next.length;
    }
    out.push(text.slice(start, i));
    start = i;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * `text` cut into pieces of exactly `budget` tokens (the last may be
 * shorter), at token starts: never inside a word, a surrogate pair, or
 * between a character and its combining mark. Concatenates back to `text`.
 */
function hardCut(text: string, budget: number): string[] {
  const starts = tokenStarts(text);
  const out: string[] = [];
  for (let k = 0; k < starts.length; k += budget) {
    const from = k === 0 ? 0 : starts[k]!;
    const to = k + budget < starts.length ? starts[k + budget]! : text.length;
    out.push(text.slice(from, to));
  }
  return out;
}

/**
 * One line longer than `budget`, cut into pieces within it: whole sentences
 * packed together where they fit, a sentence longer than the budget cut at
 * token boundaries. Concatenates back to the line.
 */
function splitLine(text: string, budget: number): string[] {
  const parts: string[] = [];
  let acc = "";
  for (const s of sentences(text)) {
    if (countTokens(s) > budget) {
      if (acc !== "") parts.push(acc);
      const pieces = hardCut(s, budget);
      parts.push(...pieces.slice(0, -1));
      acc = pieces[pieces.length - 1] ?? "";
      continue;
    }
    const merged = acc + s;
    if (acc !== "" && countTokens(merged) > budget) {
      parts.push(acc);
      acc = s;
    } else {
      acc = merged;
    }
  }
  if (acc !== "") parts.push(acc);
  return parts;
}

/**
 * A block too large for one chunk, as a run of single-line blocks of the
 * same kind, each within `budget`: its lines, and any line over the budget
 * split by {@link splitLine}. Line numbers are kept, so a split line's
 * pieces all point at the line they came from.
 */
function splitBlock(block: Block, budget: number): Block[] {
  const units: Block[] = [];
  for (const line of block.lines) {
    const t = countTokens(line.text);
    if (t <= budget) {
      units.push({ kind: block.kind, lines: [line], tokenCount: t });
      continue;
    }
    for (const part of splitLine(line.text, budget)) {
      units.push({
        kind: block.kind,
        lines: [{ num: line.num, text: part }],
        tokenCount: countTokens(part),
      });
    }
  }
  return units;
}

function packBlocks(
  blocks: ReadonlyArray<Block>,
  opts: { maxTokens: number; minTokens: number; overlapTokens: number },
): MarkdownChunk[] {
  const out: MarkdownChunk[] = [];
  let draft = newDraft();
  let pendingOverlap: Line[] = [];
  let pendingOverlapTokens = 0;
  // Pieces of a split block leave room for a full overlap, so the overlap
  // survives the split - up to half the chunk; a larger configured overlap
  // is trimmed to fit instead (see emitChunk).
  const unitBudget = Math.max(
    1,
    opts.maxTokens - Math.min(opts.overlapTokens, Math.floor(opts.maxTokens / 2)),
  );

  const setOverlap = (lines: Line[]) => {
    pendingOverlap = lines;
    pendingOverlapTokens = tokensOfLines(lines);
  };

  const flush = () => {
    if (draft.blocks.length === 0) return;
    out.push(emitChunk(out.length, pendingOverlap, draft, opts.maxTokens));
    setOverlap(takeOverlap(draft, opts.overlapTokens));
    draft = newDraft();
  };

  // The overlap is prepended to the chunk, so it spends the same budget.
  const fits = (block: Block) =>
    pendingOverlapTokens + draft.tokens + block.tokenCount <= opts.maxTokens;

  const push = (block: Block) => {
    draft.blocks.push(block);
    draft.tokens += block.tokenCount;
  };

  for (const block of blocks) {
    if (block.kind === "frontmatter") {
      // Flush any in-progress (shouldn't happen — frontmatter is first), then
      // emit the frontmatter as its own chunk(s) *without* overlap since
      // nothing precedes it. Only an oversize frontmatter becomes several.
      flush();
      const units = block.tokenCount > opts.maxTokens ? splitBlock(block, opts.maxTokens) : [block];
      let fm = newDraft();
      for (const unit of units) {
        if (fm.blocks.length > 0 && fm.tokens + unit.tokenCount > opts.maxTokens) {
          out.push(emitChunk(out.length, [], fm, opts.maxTokens));
          fm = newDraft();
        }
        fm.blocks.push(unit);
        fm.tokens += unit.tokenCount;
      }
      out.push(emitChunk(out.length, [], fm, opts.maxTokens));
      // The next chunk should NOT include frontmatter text as overlap.
      setOverlap([]);
      continue;
    }

    if (block.kind === "heading") {
      const hasNonHeading = draft.blocks.some((b) => b.kind !== "heading");
      if (hasNonHeading && draft.tokens >= opts.minTokens) {
        flush();
      }
    }

    if (draft.blocks.length > 0 && !fits(block)) {
      flush();
    }
    if (fits(block)) {
      push(block);
      continue;
    }

    // Too large to share a chunk with its own overlap: split it, and pack
    // the pieces like any other blocks.
    for (const unit of splitBlock(block, unitBudget)) {
      if (draft.blocks.length > 0 && !fits(unit)) flush();
      push(unit);
    }
  }

  flush();
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function resolveTitle(
  frontmatterBlock: Block | null,
  blocks: ReadonlyArray<Block>,
  filenameBase: string | null,
): string | null {
  if (frontmatterBlock) {
    for (const l of frontmatterBlock.lines) {
      const m = l.text.match(/^title:\s*(.*)$/);
      if (m) {
        const v = stripQuotes(m[1] ?? "");
        if (v) return v;
      }
    }
  }
  for (const b of blocks) {
    if (b.kind === "heading") {
      const text = b.lines[0]!.text.replace(/^#{1,6}\s+/, "").trim();
      if (text) return text;
    }
    if (b.kind !== "frontmatter") break;
  }
  if (filenameBase) return filenameBase.replace(/[-_]+/g, " ").trim() || filenameBase;
  return null;
}

interface HeadingMark {
  readonly line: number;
  readonly level: number;
  readonly text: string;
}

/** Collect heading marks (line, level, text) in document order. */
function collectHeadings(blocks: ReadonlyArray<Block>): HeadingMark[] {
  const out: HeadingMark[] = [];
  for (const b of blocks) {
    if (b.kind !== "heading") continue;
    const raw = b.lines[0]!.text;
    const hashes = raw.match(/^#{1,6}/);
    const level = hashes ? hashes[0].length : 1;
    const text = raw.replace(/^#{1,6}\s+/, "").trim();
    if (text) out.push({ line: b.lines[0]!.num, level, text });
  }
  return out;
}

/**
 * Breadcrumb of headings in effect at `atLine` (the chunk's end line):
 * replay heading marks at or before the line, maintaining a level-stack
 * (a heading pops every entry at its level or deeper). Returns the stack
 * texts joined " > ".
 */
function headingPathAt(headings: ReadonlyArray<HeadingMark>, atLine: number): string {
  const stack: HeadingMark[] = [];
  for (const h of headings) {
    if (h.line > atLine) break;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.map((h) => h.text).join(" > ");
}

/**
 * Two-pass markdown chunker. Pure function: same input → same output.
 *
 * Returns `chunks: []` for empty or whitespace-only input; the indexer
 * still records a `documents` row so the file is tracked.
 */
export function chunkMarkdown(
  text: string,
  filenameBase: string | null,
  opts?: ChunkOptions,
): ChunkResult {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const minTokens = opts?.minTokens ?? DEFAULT_MIN_TOKENS;
  const overlapTokens = opts?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;

  const allLines = splitLines(text);
  if (allLines.every((l) => isBlank(l.text))) {
    return Object.freeze({
      title: filenameBase ? filenameBase.replace(/[-_]+/g, " ") : null,
      chunks: Object.freeze([]),
      warnings: Object.freeze([]),
    });
  }

  const { blocks, warnings } = splitIntoBlocks(allLines);
  const frontmatter = blocks.find((b) => b.kind === "frontmatter") ?? null;
  const title = resolveTitle(frontmatter, blocks, filenameBase);
  const packed = packBlocks(blocks, { maxTokens, minTokens, overlapTokens });

  // Anchor each chunk to the heading breadcrumb active at its end (the
  // deepest section it spans).
  const headings = collectHeadings(blocks);
  const chunks =
    headings.length === 0
      ? packed
      : packed.map((c) => Object.freeze({ ...c, headingPath: headingPathAt(headings, c.endLine) }));

  return Object.freeze({
    title,
    chunks: Object.freeze(chunks),
    warnings: Object.freeze(warnings),
  });
}
