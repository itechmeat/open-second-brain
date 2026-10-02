/**
 * Block resolver: maps an Obsidian block id (the `^id` sigil) to the text of
 * the block it marks inside a source. Nothing else in the codebase resolves a
 * block id to its text; the distill quote check compares a quoted span with
 * what this returns.
 *
 * Structural only, never over natural-language vocabulary:
 *
 * - Line endings are normalised (CRLF and CR to LF) before anything else, so a
 *   CRLF source resolves exactly as its LF twin.
 * - Fenced code (``` or ~~~, three or more) is skipped: an id inside a fence is
 *   code, not a definition.
 * - A line ending in whitespace plus `^id` defines a paragraph or list-item
 *   block: a list item resolves to that item (from its marker line), anything
 *   else to its paragraph (the run of non-blank lines up to the marker line).
 *   The marker itself is removed from the returned text. A line that looks
 *   like an item continues a paragraph unless it may start a list there (see
 *   {@link listItemLines}), so `1999) was a year` inside a paragraph is text.
 * - The source is indexed once ({@link indexBlocks}) and every lookup after
 *   that is a map read; a block's text is built only when it is looked up.
 * - A line holding only `^id` attaches to the block directly above it (a
 *   table, a blockquote, a list, a fenced block), skipping blank lines.
 * - Two definitions of one id are ambiguous; the caller decides what that
 *   means, this module never picks one.
 */

/** Structural grammar of an Obsidian block id (the text after `#^`). */
export const BLOCK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

const BLOCK_ID_BODY = BLOCK_ID_RE.source.slice(1, -1);
/** A trailing `^id` preceded by whitespace on a line with other content. */
const TRAILING_MARKER_RE = new RegExp(`^(.*\\S)[ \\t]+\\^(${BLOCK_ID_BODY})[ \\t]*$`);
/** A line that holds nothing but `^id`. */
const STANDALONE_MARKER_RE = new RegExp(`^[ \\t]*\\^(${BLOCK_ID_BODY})[ \\t]*$`);
/** Opening (or closing) fence: up to three spaces of indent, three or more backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A list-item marker line: a bullet or an ordered-list number followed by whitespace. */
export const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
/**
 * An item that may interrupt a paragraph: a bullet, or an ordered item
 * numbered 1 (the CommonMark rule; any other number continues the paragraph).
 */
const PARAGRAPH_INTERRUPTING_ITEM_RE = /^[ \t]*(?:[-*+]|0*1[.)])[ \t]+/;
/** CRLF and lone CR, both folded to LF before anything else. */
const LINE_ENDING_RE = /\r\n?/g;
/** An ATX heading line; a heading is always a block of its own. */
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** What a block id resolves to inside one source. */
export type BlockResolution =
  | { readonly kind: "found"; readonly text: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous" };

/** One contiguous block of the source. */
interface Segment {
  /** For a fence, its inner lines; otherwise the segment's own lines. */
  readonly text: ReadonlyArray<string>;
  readonly fenced: boolean;
}

/**
 * Split the source into segments: whole fenced blocks, headings, and runs of
 * non-blank lines. Blank lines separate segments and belong to none.
 */
function segment(lines: ReadonlyArray<string>): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const marker = fence[1]!;
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j]!, marker)) j++;
      out.push({ text: lines.slice(i + 1, j), fenced: true });
      i = j + 1;
      continue;
    }
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    if (HEADING_RE.test(line)) {
      out.push({ text: [line], fenced: false });
      i++;
      continue;
    }
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j]!.trim().length > 0 &&
      !FENCE_RE.test(lines[j]!) &&
      !HEADING_RE.test(lines[j]!)
    ) {
      j++;
    }
    out.push({ text: lines.slice(i, j), fenced: false });
    i = j;
  }
  return out;
}

function closesFence(line: string, opener: string): boolean {
  const m = FENCE_RE.exec(line);
  return (
    m !== null &&
    m[1]![0] === opener[0] &&
    m[1]!.length >= opener.length &&
    m[2]!.trim().length === 0
  );
}

/**
 * Which of `lines` start a list item. Blank lines end a run. A run whose
 * first line is an item is a list, and every item line in it starts an
 * item; inside a paragraph only a bullet or an item numbered 1 starts a
 * list, after which the run is a list.
 */
export function listItemLines(lines: ReadonlyArray<string>): ReadonlyArray<boolean> {
  let runStart = true;
  let inList = false;
  return lines.map((line) => {
    if (line.trim().length === 0) {
      runStart = true;
      inList = false;
      return false;
    }
    const item =
      LIST_ITEM_RE.test(line) && (runStart || inList || PARAGRAPH_INTERRUPTING_ITEM_RE.test(line));
    runStart = false;
    if (item) inList = true;
    return item;
  });
}

/** Every block id of one source, mapped to its definitions, each built on demand. */
export type BlockIndex = ReadonlyMap<string, ReadonlyArray<() => string>>;

/**
 * Index every block-id definition of `source` in one pass over its
 * segments. A definition's text is built only when it is looked up, so a
 * source with many ids costs one scan, not one per id.
 */
export function indexBlocks(source: string): BlockIndex {
  const lines = source.replace(LINE_ENDING_RE, "\n").split("\n");
  const segments = segment(lines);
  const index = new Map<string, Array<() => string>>();
  const define = (id: string, text: () => string): void => {
    const list = index.get(id);
    if (list === undefined) index.set(id, [text]);
    else list.push(text);
  };
  segments.forEach((seg, segIndex) => {
    if (seg.fenced) return;
    seg.text.forEach((line, offset) => {
      const standalone = STANDALONE_MARKER_RE.exec(line);
      if (standalone !== null) {
        // Lines of this run above the marker, else the whole segment above.
        const above =
          offset > 0
            ? seg.text.slice(0, offset)
            : segIndex > 0
              ? segments[segIndex - 1]!.text
              : null;
        if (above !== null && above.length > 0) define(standalone[1]!, () => above.join("\n"));
        return;
      }
      const trailing = TRAILING_MARKER_RE.exec(line);
      if (trailing === null) return;
      const content = trailing[1]!;
      define(trailing[2]!, () => blockLines([...seg.text.slice(0, offset), content]).join("\n"));
    });
  });
  return index;
}

/**
 * The block a trailing marker on the LAST of `lines` closes: the list item it
 * belongs to when the run is a list, else the whole paragraph.
 */
function blockLines(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  const items = listItemLines(lines);
  for (let k = lines.length - 1; k >= 0; k--) {
    if (items[k] === true) return lines.slice(k);
  }
  return lines;
}

/** Look `blockId` up in an index built by {@link indexBlocks}. */
export function lookupBlock(index: BlockIndex, blockId: string): BlockResolution {
  const found = index.get(blockId);
  if (found === undefined || found.length === 0) return { kind: "not-found" };
  if (found.length > 1) return { kind: "ambiguous" };
  return { kind: "found", text: found[0]!() };
}

/**
 * Resolve `blockId` (the id only, no `^`) to the text of the block it marks
 * in `source`. Pure; never throws on any input. A caller resolving several
 * ids in one source indexes it once with {@link indexBlocks} instead.
 */
export function resolveBlock(source: string, blockId: string): BlockResolution {
  return lookupBlock(indexBlocks(source), blockId);
}
