/**
 * Quoted spans in claim text, and the one normalisation used to compare them.
 *
 * A distillation claim that wraps words in quotation marks asserts that the
 * source says exactly those words. Checking that needs two things this module
 * owns: finding the spans, and a comparison that forgives presentation
 * (Markdown, Unicode composition, quote-mark width, whitespace) while never
 * forgiving wording, case or punctuation.
 *
 * DELIMITERS. A quotation mark is any code point with the Unicode binary
 * property `Quotation_Mark`. No language list: the property already covers
 * the ASCII marks, the curly marks, low-9 marks, guillemets and the CJK corner
 * brackets. `QUOTE_VARIANT_RE` in `entities/canonical.ts` is a different
 * population (identity-key folding, pinned over the whole code-point space)
 * and is deliberately not reused for detection.
 *
 * DIRECTIONAL MARKS. A quotation mark whose general category is opening
 * (`Ps`: low-9 marks, corner brackets) or closing (`Pe`) punctuation says
 * which it is by itself: it opens before a non-space, closes after one, and
 * is never an apostrophe, because CJK running text glues corner brackets to
 * letters on both sides.
 *
 * PAIRING BY POSITION, NOT BY GLYPH. Which of the other marks opens and which
 * closes differs between writing traditions (`»…«` and `«…»`, `„…“` and
 * `“…”`), so such a mark is classified by what stands beside it: an opener
 * follows the start, whitespace, punctuation (opening, dash or other, but not
 * a mark that just closed) or another opener, and precedes a non-space; a
 * closer precedes the end, whitespace or punctuation, and follows a
 * non-space. One no-break, narrow no-break or thin space between a mark and
 * its text is transparent (spaced guillemets); an ordinary space is not. A
 * non-directional mark with a letter on both sides is an apostrophe in any
 * script and is never a delimiter.
 *
 * PAIRING WITHIN ONE WIDTH. A closer pairs only with an opener of its own
 * width class (double or single, by the shared quote fold; a directional mark
 * pairs with either), so a trailing possessive apostrophe never ends a double
 * quote: a single-width closer whose innermost opener is of the other class is
 * not a delimiter, and a double-width closer skips (and counts as unpaired)
 * any single-width openers left open inside it.
 *
 * WHAT IS REPORTED. Every closed pair is collected and only the outermost
 * among the closed pairs are spans, so an opener that never closes (a leading
 * apostrophe as in `'90s`) encloses nothing and hides no later quote; an
 * inner quote is part of its outer span's text. A pair whose text holds fewer
 * than two letters or digits (`rock 'n' roll`, an empty pair) is not a span.
 *
 * Unpaired marks are not spans: they are counted and left alone.
 */

import {
  foldQuoteVariantsByClass,
  QUOTE_VARIANT_FOLD_TARGET,
  QUOTE_VARIANT_FOLD_TARGET_DOUBLE,
} from "../entities/canonical.ts";
import { listItemLines, LIST_ITEM_RE } from "./block-resolve.ts";

/** A quotation mark, by Unicode property rather than by a list. */
export const QUOTATION_MARK_RE = /\p{Quotation_Mark}/u;

/** One quoted span: offsets of its two marks in the scanned text. */
export interface QuoteSpan {
  /** UTF-16 offset of the opening mark. */
  readonly open: number;
  /** UTF-16 offset of the closing mark. */
  readonly close: number;
  /** The text between the two marks, verbatim. */
  readonly inner: string;
}

/** The spans found in one text, and the marks that paired with nothing. */
export interface QuoteSpanScan {
  readonly spans: ReadonlyArray<QuoteSpan>;
  readonly unpaired: number;
}

const LETTER_RE = /\p{L}/u;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const WHITESPACE_RE = /\s/u;
/** What may stand before an opener: opening, dash or other punctuation. */
const OPENING_CONTEXT_RE = /[\p{Ps}\p{Pi}\p{Pd}\p{Po}]/u;
const PUNCTUATION_RE = /\p{P}/u;
const DIRECTIONAL_OPEN_RE = /\p{Ps}/u;
const DIRECTIONAL_CLOSE_RE = /\p{Pe}/u;
/** No-break, narrow no-break and thin space: transparent once beside a mark. */
const INNER_QUOTE_SPACE_RE = /[   ]/u;
/** A span needs at least this many letters or digits between its marks. */
const SPAN_MIN_LETTERS_OR_DIGITS = 2;
/** The width class of a directional mark: it pairs with either width. */
const ANY_WIDTH = "any";

/** One code point and its UTF-16 offset. */
interface CodePointAt {
  readonly ch: string;
  readonly at: number;
}

function codePoints(text: string): ReadonlyArray<CodePointAt> {
  const out: CodePointAt[] = [];
  let at = 0;
  for (const ch of text) {
    out.push({ ch, at });
    at += ch.length;
  }
  return out;
}

const isLetter = (ch: string | undefined): boolean => ch !== undefined && LETTER_RE.test(ch);
const isSpace = (ch: string | undefined): boolean => ch !== undefined && WHITESPACE_RE.test(ch);

/** The width class a mark pairs within: the shared fold, or any for a directional mark. */
function widthClass(ch: string): string {
  return DIRECTIONAL_OPEN_RE.test(ch) || DIRECTIONAL_CLOSE_RE.test(ch)
    ? ANY_WIDTH
    : foldQuoteVariantsByClass(ch);
}

const sameWidth = (a: string, b: string): boolean => a === b || a === ANY_WIDTH || b === ANY_WIDTH;

/** How a mark may act, decided by its neighbours; `null` for an apostrophe. */
interface MarkRole {
  readonly opens: boolean;
  readonly closes: boolean;
}

/** The neighbour on one side, looking through one typographic inner space. */
function neighbour(
  points: ReadonlyArray<CodePointAt>,
  i: number,
  step: 1 | -1,
): string | undefined {
  const near = points[i + step]?.ch;
  return near !== undefined && INNER_QUOTE_SPACE_RE.test(near) ? points[i + 2 * step]?.ch : near;
}

function markRole(
  points: ReadonlyArray<CodePointAt>,
  i: number,
  prevOpened: boolean,
  prevClosed: boolean,
): MarkRole | null {
  const ch = points[i]!.ch;
  const prev = points[i - 1]?.ch;
  const next = points[i + 1]?.ch;
  const textAfter = neighbour(points, i, 1);
  const textBefore = neighbour(points, i, -1);
  if (DIRECTIONAL_OPEN_RE.test(ch)) {
    return { opens: textAfter !== undefined && !isSpace(textAfter), closes: false };
  }
  if (DIRECTIONAL_CLOSE_RE.test(ch)) {
    return { opens: false, closes: textBefore !== undefined && !isSpace(textBefore) };
  }
  if (isLetter(prev) && isLetter(next)) return null;
  const opensAfter =
    prev === undefined ||
    isSpace(prev) ||
    prevOpened ||
    (!prevClosed && OPENING_CONTEXT_RE.test(prev));
  const opens = opensAfter && textAfter !== undefined && !isSpace(textAfter);
  const closes =
    (next === undefined || isSpace(next) || PUNCTUATION_RE.test(next)) &&
    textBefore !== undefined &&
    !isSpace(textBefore);
  return { opens, closes };
}

/** An opener still waiting for its closer. */
interface OpenMark {
  readonly at: number;
  readonly width: string;
}

/** Find the outermost quoted spans of `text`. See the module docblock. */
export function findQuoteSpans(text: string): QuoteSpanScan {
  const points = codePoints(text);
  const pairs: QuoteSpan[] = [];
  const stack: OpenMark[] = [];
  // Open marks per width class, so a closer with no opener of its class is
  // answered without walking the stack.
  const openByWidth = new Map<string, number>();
  const bump = (width: string, by: number): void => {
    openByWidth.set(width, (openByWidth.get(width) ?? 0) + by);
  };
  let unpaired = 0;
  let prevOpened = false;
  let prevClosed = false;

  /** The stack index of the opener `width` closes, or -1. */
  const openerFor = (width: string): number => {
    const top = stack.length - 1;
    if (top < 0) return -1;
    // A single-width closer closes only the innermost opener: anything else
    // there makes it an apostrophe (`"the students' work"`).
    if (width === QUOTE_VARIANT_FOLD_TARGET) return sameWidth(stack[top]!.width, width) ? top : -1;
    if (
      width !== ANY_WIDTH &&
      (openByWidth.get(width) ?? 0) + (openByWidth.get(ANY_WIDTH) ?? 0) === 0
    ) {
      return -1;
    }
    for (let k = top; k >= 0; k--) if (sameWidth(stack[k]!.width, width)) return k;
    return -1;
  };

  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    if (!QUOTATION_MARK_RE.test(point.ch)) {
      prevOpened = false;
      prevClosed = false;
      continue;
    }
    const role = markRole(points, i, prevOpened, prevClosed);
    prevOpened = false;
    prevClosed = false;
    if (role === null) continue;
    const width = widthClass(point.ch);
    if (role.closes && (stack.length > 0 || !role.opens)) {
      const k = openerFor(width);
      if (k !== -1) {
        // Openers left open inside this pair (a leading apostrophe) are
        // abandoned and counted once, here.
        for (let j = stack.length - 1; j > k; j--) bump(stack[j]!.width, -1);
        unpaired += stack.length - 1 - k;
        const open = stack[k]!;
        stack.length = k;
        bump(open.width, -1);
        const inner = text.slice(open.at + codePointLength(text, open.at), point.at);
        pairs.push({ open: open.at, close: point.at, inner });
        prevClosed = true;
        continue;
      }
      if (!role.opens) {
        unpaired += 1;
        continue;
      }
    }
    if (role.opens) {
      stack.push({ at: point.at, width });
      bump(width, 1);
      prevOpened = true;
      continue;
    }
    unpaired += 1;
  }
  unpaired += stack.length;

  // Outermost among the CLOSED pairs. Pairs never cross (a stack made them),
  // so in opening order a pair is enclosed exactly when an earlier one closes
  // after it.
  const spans: QuoteSpan[] = [];
  let reach = -1;
  for (const pair of pairs.toSorted((a, b) => a.open - b.open)) {
    if (pair.close < reach) continue;
    reach = pair.close;
    if (!hasLettersOrDigits(pair.inner, SPAN_MIN_LETTERS_OR_DIGITS)) {
      unpaired += 2;
      continue;
    }
    spans.push(pair);
  }
  return { spans, unpaired };
}

/** Does `text` hold at least `min` letters or digits? Stops counting at `min`. */
function hasLettersOrDigits(text: string, min: number): boolean {
  let count = 0;
  for (const ch of text) {
    if (LETTER_OR_DIGIT_RE.test(ch) && ++count >= min) return true;
  }
  return false;
}

/** Length in UTF-16 units of the code point at `at`. */
function codePointLength(text: string, at: number): number {
  return String.fromCodePoint(text.codePointAt(at) ?? 0).length;
}

/** Remove exactly the two marks of each given span; every other byte stays. */
export function unquoteSpans(text: string, spans: ReadonlyArray<QuoteSpan>): string {
  const cuts = spans.flatMap((span) => [span.open, span.close]).toSorted((a, b) => b - a);
  let out = text;
  for (const at of cuts) out = out.slice(0, at) + out.slice(at + codePointLength(out, at));
  return out;
}

// Every pattern below is linear on any input: a character class that cannot
// hold the bracket that starts a match means a failed attempt never overlaps
// the next one, and the line-anchored ones run once per line.

/** `[[target|alias]]`, reduced to the alias. */
const WIKILINK_ALIASED_RE = /\[\[[^[\]|]*\|([^[\]]*)\]\]/g;
/** `[[target]]`, reduced to the target. */
const WIKILINK_RE = /\[\[([^[\]]*)\]\]/g;
/** `[text](url)`, reduced to the text. */
const MARKDOWN_LINK_RE = /\[([^[\]]*)\]\([^()]*\)/g;
/** Blockquote markers at the start of a line. */
const BLOCKQUOTE_PREFIX_RE = /^[ \t]*(?:>[ \t]?)+/;
/** An Obsidian block id: what follows the caret. */
const BLOCK_ID_TAIL_RE = /^\^[A-Za-z0-9][A-Za-z0-9-]*$/;
const WHITESPACE_RUN_RE = /\s+/gu;
/** Bracket-type quotation marks (low-9 marks, corner brackets) for the comparison fold. */
const BRACKET_PUNCTUATION_RE = /[\p{Ps}\p{Pe}]/gu;
/** The emphasis, strike and code delimiter characters. */
const INLINE_DELIMITER_CHARS: ReadonlySet<string> = new Set(["*", "_", "~", "`"]);
const STRIKE_DELIMITER = "~~";
const LINE_HORIZONTAL_SPACE = new Set([" ", "\t", "\r"]);

/**
 * `line` without an Obsidian block id ending it or standing alone on it. A
 * caret glued to a word is text. Scans the line once, with no regex over the
 * whitespace before the id.
 */
function stripTrailingBlockId(line: string): string {
  let end = line.length;
  while (end > 0 && LINE_HORIZONTAL_SPACE.has(line[end - 1]!)) end--;
  const caret = line.lastIndexOf("^", end - 1);
  if (caret === -1 || !BLOCK_ID_TAIL_RE.test(line.slice(caret, end))) return line;
  let start = caret;
  while (start > 0 && LINE_HORIZONTAL_SPACE.has(line[start - 1]!)) start--;
  return start === caret && caret > 0 ? line : line.slice(0, start);
}

/**
 * Block markers removed line by line: blockquote prefixes, list prefixes on
 * the lines that start an item (the rule `block-resolve.ts` resolves blocks
 * by), and trailing block ids.
 */
function stripLineMarkers(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(BLOCKQUOTE_PREFIX_RE, ""));
  const items = listItemLines(lines);
  return lines
    .map((line, k) => stripTrailingBlockId(items[k] ? line.replace(LIST_ITEM_RE, "") : line))
    .join("\n");
}

/**
 * Inline emphasis, strike and code delimiters reduced to their content, in
 * one linear pass. Only a PAIR is removed: a run of `*`, `_` or backticks
 * (or `~~`) that can open (followed by a non-space) and a later run of the
 * same characters that can close (preceded by a non-space). An underscore
 * between two letters or digits never delimits, so `snake_case` and `2*3`
 * keep their bytes.
 */
function stripInlineDelimiters(text: string): string {
  const drop: Array<readonly [number, number]> = [];
  const pending = new Map<string, number>();
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (!INLINE_DELIMITER_CHARS.has(ch)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < text.length && text[end] === ch) end++;
    const run = text.slice(i, end);
    if (ch === "~" && run !== STRIKE_DELIMITER) {
      i = end;
      continue;
    }
    const before = text[i - 1];
    const after = text[end];
    const intraword = ch === "_";
    const canClose =
      before !== undefined &&
      !isSpace(before) &&
      !(intraword && after !== undefined && LETTER_OR_DIGIT_RE.test(after));
    const canOpen =
      after !== undefined &&
      !isSpace(after) &&
      !(intraword && before !== undefined && LETTER_OR_DIGIT_RE.test(before));
    const open = pending.get(run);
    if (canClose && open !== undefined) {
      drop.push([open, open + run.length], [i, end]);
      pending.delete(run);
    } else if (canOpen) {
      pending.set(run, i);
    }
    i = end;
  }
  if (drop.length === 0) return text;
  drop.sort((a, b) => a[0] - b[0]);
  let out = "";
  let from = 0;
  for (const [start, stop] of drop) {
    out += text.slice(from, start);
    from = stop;
  }
  return out + text.slice(from);
}

/** Options of {@link normalizeForQuoteComparison}. */
export interface QuoteNormalizeOptions {
  /**
   * Remove line-leading blockquote and list markers (default `true`). A span
   * passes `false`: it is one run of the claim's own words, so a leading
   * `3. ` or `> ` in it is wording to match, not a block marker.
   */
  readonly lineMarkers?: boolean;
}

/**
 * The comparison form of a text, applied identically to a span and to the
 * text it is checked against: NFC; block markers (on the evidence side only,
 * see {@link QuoteNormalizeOptions.lineMarkers}), trailing block ids and
 * paired inline Markdown reduced to display text; quote marks folded to their
 * ASCII width (bracket-type quotation marks to `"`); whitespace collapsed.
 * Case, punctuation and wording are untouched. Comparison only: no page byte
 * is ever rewritten through this function. Linear in the length of `text`.
 */
export function normalizeForQuoteComparison(
  text: string,
  opts: QuoteNormalizeOptions = {},
): string {
  const nfc = text.normalize("NFC");
  const lined =
    opts.lineMarkers === false
      ? nfc
          .split("\n")
          .map((line) => stripTrailingBlockId(line))
          .join("\n")
      : stripLineMarkers(nfc);
  const reduced = stripInlineDelimiters(
    lined
      .replace(WIKILINK_ALIASED_RE, "$1")
      .replace(WIKILINK_RE, "$1")
      .replace(MARKDOWN_LINK_RE, "$1"),
  );
  return foldQuoteVariantsByClass(reduced)
    .replace(BRACKET_PUNCTUATION_RE, (mark) =>
      QUOTATION_MARK_RE.test(mark) ? QUOTE_VARIANT_FOLD_TARGET_DOUBLE : mark,
    )
    .replace(WHITESPACE_RUN_RE, " ")
    .trim();
}

/** U+2026 or a run of three or more full stops. */
const ELLIPSIS_RE = /…|\.{3,}/u;
/** A span that opens with an ellipsis: its first fragment may start inside a word. */
const LEADING_ELLIPSIS_RE = /^\s*(?:…|\.{3,})/u;
/** A span that closes with an ellipsis: its last fragment may end inside a word. */
const TRAILING_ELLIPSIS_RE = /(?:…|\.{3,})\s*$/u;

/** The fragments an ellipsis separates, trimmed, empty ones dropped. */
export function splitEllipsisFragments(inner: string): ReadonlyArray<string> {
  return inner
    .split(ELLIPSIS_RE)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

/** Word segmentation by the Unicode rules (dictionary-based for scripts written without spaces). */
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * An already-normalised text a span is searched in, with its word boundaries.
 * The segmentation is built on the first boundary question and reused for
 * every later one, so a haystack shared by many claims is segmented once.
 */
export interface QuoteHaystack {
  readonly normalized: string;
  /** Does a word boundary fall at `offset` (the two ends of the text always do)? */
  isWordBoundary(offset: number): boolean;
}

/** Wrap a normalised text (from {@link normalizeForQuoteComparison}) as a haystack. */
export function quoteHaystack(normalized: string): QuoteHaystack {
  let segments: Intl.Segments | undefined;
  return {
    normalized,
    isWordBoundary(offset: number): boolean {
      if (offset <= 0 || offset >= normalized.length) return true;
      segments ??= WORD_SEGMENTER.segment(normalized);
      return segments.containing(offset)?.index === offset;
    },
  };
}

/**
 * Does the quoted `inner` occur in an already-normalised haystack? Every
 * ellipsis fragment must appear, in order, without overlapping the previous
 * one. The outer ends of the span must fall on word boundaries of the
 * haystack, so `"safe"` does not verify inside `unsafe`; an edge next to an
 * ellipsis is free, since an ellipsis may cut a word on purpose. A span that
 * is nothing but an ellipsis quotes nothing and fails.
 */
export function spanOccursIn(inner: string, haystack: string | QuoteHaystack): boolean {
  const target = typeof haystack === "string" ? quoteHaystack(haystack) : haystack;
  const text = target.normalized;
  const fragments = splitEllipsisFragments(inner)
    .map((fragment) => normalizeForQuoteComparison(fragment, { lineMarkers: false }))
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0) return false;
  const openStart = LEADING_ELLIPSIS_RE.test(inner);
  const openEnd = TRAILING_ELLIPSIS_RE.test(inner);
  const last = fragments.length - 1;
  let from = 0;
  for (const [k, fragment] of fragments.entries()) {
    const startBound = k === 0 && !openStart;
    const endBound = k === last && !openEnd;
    const fits = (at: number): boolean =>
      (!startBound || target.isWordBoundary(at)) &&
      (!endBound || target.isWordBoundary(at + fragment.length));
    let at = text.indexOf(fragment, from);
    while (at !== -1 && !fits(at)) at = text.indexOf(fragment, at + 1);
    if (at === -1) return false;
    from = at + fragment.length;
  }
  return true;
}
