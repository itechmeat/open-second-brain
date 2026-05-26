/**
 * Markdown chunker — two-pass structural split + token-budget packer.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §6.
 *
 * Token approximation: whitespace word count. Deterministic across
 * Bun/Node, dependency-free, machine-independent — so the same vault
 * hashes the same chunks on every Syncthing peer.
 */

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

function countTokens(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isSpace = c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
    if (!isSpace) {
      if (!inWord) {
        count++;
        inWord = true;
      }
    } else {
      inWord = false;
    }
  }
  return count;
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

function extractFrontmatter(
  lines: ReadonlyArray<Line>,
): { block: Block | null; remaining: ReadonlyArray<Line>; warnings: string[] } {
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
      blocks.push(makeBlock("code", [...remaining.slice(i, end + 1)]));
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
      blocks.push(makeBlock("list", [...remaining.slice(i, end + 1)]));
      i = end + 1;
      continue;
    }
    if (isTableStart(remaining, i)) {
      const { end } = readTable(remaining, i);
      blocks.push(makeBlock("table", [...remaining.slice(i, end + 1)]));
      i = end + 1;
      continue;
    }
    const { end } = readParagraph(remaining, i);
    blocks.push(makeBlock("paragraph", [...remaining.slice(i, end + 1)]));
    i = end + 1;
  }

  return { blocks, warnings };
}

interface DraftChunk {
  blocks: Block[];
  startLine: number;
  endLine: number;
  tokens: number;
}

function newDraft(): DraftChunk {
  return { blocks: [], startLine: 0, endLine: 0, tokens: 0 };
}

function takeOverlap(prev: DraftChunk, overlapTokens: number): Line[] {
  if (overlapTokens <= 0 || prev.blocks.length === 0) return [];
  // Flatten lines of previous chunk's body in order, then take tail until token budget.
  const allLines: Line[] = [];
  for (const b of prev.blocks) for (const l of b.lines) allLines.push(l);
  let acc = 0;
  const tail: Line[] = [];
  for (let i = allLines.length - 1; i >= 0; i--) {
    const t = countTokens(allLines[i]!.text);
    if (acc + t > overlapTokens && tail.length > 0) break;
    tail.unshift(allLines[i]!);
    acc += t;
  }
  return tail;
}

function emitChunk(
  index: number,
  overlap: ReadonlyArray<Line>,
  draft: DraftChunk,
): MarkdownChunk {
  const bodyLines: Line[] = [];
  for (const b of draft.blocks) for (const l of b.lines) bodyLines.push(l);
  const allText = [
    ...overlap.map((l) => l.text),
    ...bodyLines.map((l) => l.text),
  ].join("\n");
  const tokenCount = countTokens(allText);
  return Object.freeze({
    chunkIndex: index,
    content: allText,
    startLine: bodyLines[0]?.num ?? overlap[0]?.num ?? 1,
    endLine: bodyLines[bodyLines.length - 1]?.num ?? overlap[overlap.length - 1]?.num ?? 1,
    tokenCount,
    headingPath: "",
  });
}

function packBlocks(
  blocks: ReadonlyArray<Block>,
  opts: { maxTokens: number; minTokens: number; overlapTokens: number },
): MarkdownChunk[] {
  const out: MarkdownChunk[] = [];
  let draft = newDraft();
  let prevForOverlap: DraftChunk | null = null;
  let pendingOverlap: Line[] = [];

  const flush = () => {
    if (draft.blocks.length === 0) return;
    const chunk = emitChunk(out.length, pendingOverlap, draft);
    out.push(chunk);
    prevForOverlap = draft;
    pendingOverlap = takeOverlap(prevForOverlap, opts.overlapTokens);
    draft = newDraft();
  };

  for (const block of blocks) {
    if (block.kind === "frontmatter") {
      // Flush any in-progress (shouldn't happen — frontmatter is first), then
      // emit the frontmatter as its own chunk *without* overlap since nothing
      // precedes it.
      flush();
      const fmContent = block.lines.map((l) => l.text).join("\n");
      out.push(
        Object.freeze({
          chunkIndex: out.length,
          content: fmContent,
          startLine: block.lines[0]!.num,
          endLine: block.lines[block.lines.length - 1]!.num,
          tokenCount: countTokens(fmContent),
          headingPath: "",
        }),
      );
      // The next chunk should NOT include frontmatter text as overlap.
      prevForOverlap = null;
      pendingOverlap = [];
      continue;
    }

    // Atomic large block — emit as its own chunk.
    if (block.tokenCount > opts.maxTokens) {
      flush();
      const standalone: DraftChunk = {
        blocks: [block],
        startLine: block.lines[0]!.num,
        endLine: block.lines[block.lines.length - 1]!.num,
        tokens: block.tokenCount,
      };
      const chunk = emitChunk(out.length, pendingOverlap, standalone);
      out.push(chunk);
      prevForOverlap = standalone;
      pendingOverlap = takeOverlap(prevForOverlap, opts.overlapTokens);
      continue;
    }

    if (block.kind === "heading") {
      const hasNonHeading = draft.blocks.some((b) => b.kind !== "heading");
      if (hasNonHeading && draft.tokens >= opts.minTokens) {
        flush();
      }
      draft.blocks.push(block);
      draft.tokens += block.tokenCount;
      continue;
    }

    if (draft.tokens + block.tokenCount > opts.maxTokens && draft.blocks.length > 0) {
      flush();
    }
    draft.blocks.push(block);
    draft.tokens += block.tokenCount;
  }

  flush();
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
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
      : packed.map((c) =>
          Object.freeze({ ...c, headingPath: headingPathAt(headings, c.endLine) }),
        );

  return Object.freeze({
    title,
    chunks: Object.freeze(chunks),
    warnings: Object.freeze(warnings),
  });
}
