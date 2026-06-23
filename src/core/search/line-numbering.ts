/**
 * Read-time virtual line numbering — pure, I/O-free helpers for precise
 * line-span citations.
 *
 * The stored Markdown is never mutated. Line markers and line slices are
 * computed on read, so a pointer like `path:L55-L72` stays valid across
 * idempotent re-mining: the bytes on disk do not shift, so the numbering a
 * pointer was minted against does not shift either.
 *
 * `renderWithLineNumbers` / `extractLineRange` mirror the two pure functions
 * the source design ships; `formatLinePointer` / `parseLinePointer` define the
 * `path:Lstart-Lend` pointer grammar; `charSpanToLineSpan` bridges the existing
 * char-offset snippet world to a line span.
 *
 * All helpers are total functions: out-of-range or inverted inputs clamp or
 * return empty rather than throwing — they sit on a read path.
 */

/** A parsed `path:Lstart-Lend` (or single-line `path:Lstart`) pointer. */
export interface LinePointer {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

const POINTER_RE = /^(.+):L(\d+)(?:-L(\d+))?$/;

function clampStart(line: number): number {
  return Math.max(1, Math.floor(line));
}

/**
 * Prefix each line of `text` with a `[N] ` marker, counting from `startLine`
 * (1-based, clamped to >= 1). Blank lines are preserved and still numbered.
 * Empty input has no line 1, so it renders to the empty string.
 */
export function renderWithLineNumbers(text: string, startLine = 1): string {
  if (text === "") return "";
  const base = clampStart(startLine);
  return text
    .split("\n")
    .map((line, index) => `[${base + index}] ${line}`)
    .join("\n");
}

/**
 * Return the verbatim bytes of `text` for the inclusive 1-based line range
 * `[lineStart, lineEnd]`, with no markers. The range is clamped into
 * `[1, lineCount]`; an inverted range, a start past the last line, or empty
 * input yields the empty string. This is the resolution half of a line pointer:
 * open the file, then slice.
 */
export function extractLineRange(text: string, lineStart: number, lineEnd: number): string {
  if (text === "") return "";
  const lines = text.split("\n");
  const start = clampStart(lineStart);
  const end = Math.min(lines.length, Math.floor(lineEnd));
  if (start > end || start > lines.length) return "";
  return lines.slice(start - 1, end).join("\n");
}

/**
 * Format a `path:Lstart-Lend` pointer, collapsing to `path:Lstart` for a single
 * line. The range is normalized: `start` clamps to >= 1 and `end` to >= start.
 */
export function formatLinePointer(path: string, lineStart: number, lineEnd: number): string {
  const start = clampStart(lineStart);
  const end = Math.max(start, Math.floor(lineEnd));
  return start === end ? `${path}:L${start}` : `${path}:L${start}-L${end}`;
}

/**
 * Parse a `path:Lstart-Lend` (or `path:Lstart`) pointer. Returns `null` for any
 * malformed input — including a sub-1 start or an end below the start. The path
 * capture is greedy, so colons that belong to the path are kept.
 */
export function parseLinePointer(pointer: string): LinePointer | null {
  const match = POINTER_RE.exec(pointer);
  if (match === null) return null;
  const path = match[1]!;
  const lineStart = Number(match[2]);
  const lineEnd = match[3] !== undefined ? Number(match[3]) : lineStart;
  if (path === "" || lineStart < 1 || lineEnd < lineStart) return null;
  return { path, lineStart, lineEnd };
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

/**
 * Map a char-offset match `[index, index + length)` to the 1-based line span it
 * touches. Indices are clamped into `[0, text.length]`. Bridges the existing
 * char-offset snippet path to a line-anchored citation.
 */
export function charSpanToLineSpan(
  text: string,
  index: number,
  length = 0,
): { readonly lineStart: number; readonly lineEnd: number } {
  const start = Math.max(0, Math.min(Math.floor(index), text.length));
  const end = Math.max(start, Math.min(Math.floor(index) + Math.max(0, length), text.length));
  // The line of the span's last *included* character: a half-open range that
  // ends exactly on a newline must not count the line that newline opens.
  const lastChar = end > start ? end - 1 : start;
  return {
    lineStart: 1 + countNewlines(text.slice(0, start)),
    lineEnd: 1 + countNewlines(text.slice(0, lastChar)),
  };
}
