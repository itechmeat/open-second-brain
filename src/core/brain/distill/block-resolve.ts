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
 *   The marker itself is removed from the returned text.
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
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
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

/** Every definition of `blockId` in the source, as the block text each one marks. */
function definitions(lines: ReadonlyArray<string>, blockId: string): string[] {
  const segments = segment(lines);
  const found: string[] = [];
  segments.forEach((seg, index) => {
    if (seg.fenced) return;
    seg.text.forEach((line, offset) => {
      const standalone = STANDALONE_MARKER_RE.exec(line);
      if (standalone !== null) {
        if (standalone[1] !== blockId) return;
        // Lines of this run above the marker, else the whole segment above.
        const above =
          offset > 0 ? seg.text.slice(0, offset) : index > 0 ? segments[index - 1]!.text : null;
        if (above !== null && above.length > 0) found.push(above.join("\n"));
        return;
      }
      const trailing = TRAILING_MARKER_RE.exec(line);
      if (trailing === null || trailing[2] !== blockId) return;
      const upTo = [...seg.text.slice(0, offset), trailing[1]!];
      found.push(blockLines(upTo).join("\n"));
    });
  });
  return found;
}

/**
 * The block a trailing marker on the LAST of `lines` closes: the list item it
 * belongs to when the run is a list, else the whole paragraph.
 */
function blockLines(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  for (let k = lines.length - 1; k >= 0; k--) {
    if (LIST_ITEM_RE.test(lines[k]!)) return lines.slice(k);
  }
  return lines;
}

/**
 * Resolve `blockId` (the id only, no `^`) to the text of the block it marks
 * in `source`. Pure; never throws on any input.
 */
export function resolveBlock(source: string, blockId: string): BlockResolution {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const found = definitions(lines, blockId);
  if (found.length === 0) return { kind: "not-found" };
  if (found.length > 1) return { kind: "ambiguous" };
  return { kind: "found", text: found[0]! };
}
