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
 * PAIRING BY POSITION, NOT BY GLYPH. Which mark opens and which closes differs
 * between writing traditions (`»…«` and `«…»`, `„…“` and `“…”`), so a mark is
 * classified by what stands beside it: an opener follows the start, whitespace,
 * opening punctuation or another opener, and precedes a non-space; a closer
 * precedes the end, whitespace or punctuation, and follows a non-space. A mark
 * with a letter on both sides is an apostrophe in any script and is never a
 * delimiter. Pairing is a stack and only outermost spans are reported; an
 * inner quote is part of its outer span's text.
 *
 * Unpaired marks are not spans: they are counted and left alone.
 */

import { foldQuoteVariantsByClass } from "../entities/canonical.ts";

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
const WHITESPACE_RE = /\s/u;
const OPENING_PUNCTUATION_RE = /[\p{Ps}\p{Pi}]/u;
const PUNCTUATION_RE = /\p{P}/u;

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

/** How a mark may act, decided by its two neighbours. */
interface MarkRole {
  readonly opens: boolean;
  readonly closes: boolean;
}

function markRole(
  prev: string | undefined,
  next: string | undefined,
  prevOpened: boolean,
): MarkRole {
  const opens =
    (prev === undefined || isSpace(prev) || OPENING_PUNCTUATION_RE.test(prev) || prevOpened) &&
    next !== undefined &&
    !isSpace(next);
  const closes =
    (next === undefined || isSpace(next) || PUNCTUATION_RE.test(next)) &&
    prev !== undefined &&
    !isSpace(prev);
  return { opens, closes };
}

/** Find the outermost quoted spans of `text`. See the module docblock. */
export function findQuoteSpans(text: string): QuoteSpanScan {
  const points = codePoints(text);
  const spans: QuoteSpan[] = [];
  const stack: number[] = [];
  let unpaired = 0;
  let prevOpened = false;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === undefined || !QUOTATION_MARK_RE.test(point.ch)) {
      prevOpened = false;
      continue;
    }
    const prev = points[i - 1]?.ch;
    const next = points[i + 1]?.ch;
    if (isLetter(prev) && isLetter(next)) {
      prevOpened = false;
      continue;
    }
    const role = markRole(prev, next, prevOpened);
    prevOpened = false;
    if (role.closes && (stack.length > 0 || !role.opens)) {
      const open = stack.pop();
      if (open === undefined) {
        unpaired += 1;
        continue;
      }
      if (stack.length === 0) {
        const inner = text.slice(open + codePointLength(text, open), point.at);
        if (inner.trim().length > 0) spans.push({ open, close: point.at, inner });
      }
      continue;
    }
    if (role.opens) {
      stack.push(point.at);
      prevOpened = true;
      continue;
    }
    unpaired += 1;
  }
  return { spans, unpaired: unpaired + stack.length };
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

/** `[[target|alias]]`, reduced to the alias. */
const WIKILINK_ALIASED_RE = /\[\[[^\]|]*\|([^\]]*)\]\]/g;
/** `[[target]]`, reduced to the target. */
const WIKILINK_RE = /\[\[([^\]]*)\]\]/g;
/** `[text](url)`, reduced to the text. */
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
/** Inline emphasis and code markers. */
const INLINE_MARKER_RE = /~~|[*_`]/g;
/** Blockquote markers at the start of a line. */
const BLOCKQUOTE_PREFIX_RE = /^[ \t]*(?:>[ \t]?)+/gm;
/** A list bullet or an ordered-list number at the start of a line. */
const LIST_PREFIX_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm;
/** An Obsidian block id ending a line, or standing alone on one. */
const TRAILING_BLOCK_ID_RE = /(?:^|[ \t]+)\^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*$/gm;
const WHITESPACE_RUN_RE = /\s+/gu;

/**
 * The comparison form of a text, applied identically to a span and to the
 * text it is checked against: NFC; block markers, trailing block ids and
 * inline Markdown reduced to display text; quote marks folded to their ASCII
 * width; whitespace collapsed. Case, punctuation and wording are untouched.
 * Comparison only: no page byte is ever rewritten through this function.
 */
export function normalizeForQuoteComparison(text: string): string {
  const reduced = text
    .normalize("NFC")
    .replace(BLOCKQUOTE_PREFIX_RE, "")
    .replace(LIST_PREFIX_RE, "")
    .replace(TRAILING_BLOCK_ID_RE, "")
    .replace(WIKILINK_ALIASED_RE, "$1")
    .replace(WIKILINK_RE, "$1")
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(INLINE_MARKER_RE, "");
  return foldQuoteVariantsByClass(reduced).replace(WHITESPACE_RUN_RE, " ").trim();
}

/** U+2026 or a run of three or more full stops. */
const ELLIPSIS_RE = /…|\.{3,}/u;

/** The fragments an ellipsis separates, trimmed, empty ones dropped. */
export function splitEllipsisFragments(inner: string): ReadonlyArray<string> {
  return inner
    .split(ELLIPSIS_RE)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

/**
 * Does the quoted `inner` occur in an already-normalised haystack? Every
 * ellipsis fragment must appear, in order, without overlapping the previous
 * one. A span that is nothing but an ellipsis quotes nothing and fails.
 */
export function spanOccursIn(inner: string, haystackNormalized: string): boolean {
  const fragments = splitEllipsisFragments(inner)
    .map(normalizeForQuoteComparison)
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0) return false;
  let from = 0;
  for (const fragment of fragments) {
    const at = haystackNormalized.indexOf(fragment, from);
    if (at === -1) return false;
    from = at + fragment.length;
  }
  return true;
}
