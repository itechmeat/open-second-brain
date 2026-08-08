/**
 * Match-anchored snippet windows — the one place a preview decides WHERE
 * in a passage to start (what-the-index-already-knew, task E).
 *
 * No match offset exists anywhere in the retrieval path: FTS5's
 * `offsets()` / `snippet()` / `highlight()` are never called, a keyword
 * hit is `{chunkId, documentId, bm25}`, and a chunk carries LINE numbers,
 * not character offsets. Nothing is dropped upstream — the offset is
 * never produced, so the window is computed here, at assembly time, from
 * the result content and the query.
 *
 * Every preview surface used to truncate from the HEAD of the chunk,
 * which made a match in the middle of a long passage invisible in the
 * only text the caller reads. The match-centred window and the
 * case-insensitive offset scan already existed — written and tested —
 * mounted on the session-recall surface alone. They live here now, and
 * the three head-truncating surfaces (MCP `content`, layer-1 card
 * snippets, the CLI transcript) call them.
 *
 * ## What this module owns, and what it deliberately does not
 *
 * It owns ANCHORING: which offset a window centres on, and where that
 * window starts. It does NOT own each surface's cap or continuation
 * marker, because the three genuinely disagree — the card snippet counts
 * CODE POINTS and appends `...` beyond its cap, the MCP window counts
 * UTF-16 units and fits its marker INSIDE a fixed token budget, the CLI
 * transcript counts UTF-16 units and appends `…` outside its cap.
 * Forcing one policy on all three would change the bytes every one of
 * them emits today, for no gain.
 *
 * ## The no-match case is a defined behaviour, not a fallback
 *
 * When no significant query term occurs in the text, {@link matchOffset}
 * returns {@link NO_MATCH_OFFSET} and the window starts at
 * {@link HEAD_WINDOW_START} — the head of the chunk, the same bytes a
 * head truncation produced before anchoring existed. The sentinel is
 * named rather than encoded as offset 0 precisely so a caller can never
 * read the result as "a match was found at position 0".
 *
 * Pure module: no I/O, no clock, no corpus access.
 */

import { significantTerms } from "./coverage.ts";

/**
 * Returned by {@link matchOffset} when no significant query term occurs
 * in the text. Distinct from offset 0, which means a term matched at the
 * very start.
 */
export const NO_MATCH_OFFSET = -1;

/** Where an unanchored window starts: the head of the text. */
export const HEAD_WINDOW_START = 0;

/** Continuation marker for a window that does not cover the whole text. */
export const ELLIPSIS = "…";

/**
 * Case-insensitive search that returns an offset into the ORIGINAL
 * `text`, so a window slice and `charSpanToLineSpan` (both of which
 * slice the original text) stay aligned. `text.toLowerCase()` is not
 * always length-preserving (e.g. U+0130 lowercases to two code units),
 * which would otherwise shift an offset taken from the lowercased copy.
 * The fast path keeps normal text O(n) and bit-identical; the scan runs
 * only when lowercasing changed the length.
 */
export function caseInsensitiveIndex(text: string, needleLower: string): number {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower.indexOf(needleLower);
  for (let i = 0; i < text.length; i++) {
    if (text.slice(i).toLowerCase().startsWith(needleLower)) return i;
  }
  return NO_MATCH_OFFSET;
}

/**
 * Earliest offset in `text` at which any SIGNIFICANT term of `query`
 * occurs, or {@link NO_MATCH_OFFSET} when none does.
 *
 * Term selection is structural and delegated whole to
 * {@link significantTerms}, the same splitter the coverage engine and the
 * evidence pack already anchor on: there is deliberately no stop-word
 * list, no language table and no second length rule invented here. A
 * corpus-common term that happens to match first costs at most a window
 * that starts where a common word does — the corpus-frequency answer to
 * "which term matters" lives in the IDF weighting downstream and needs
 * document frequencies no preview surface holds.
 *
 * Earliest-occurrence, not longest-term or densest-cluster: it is
 * deterministic, needs no corpus, and cannot reorder under a tie.
 */
export function matchOffset(text: string, query: string): number {
  let earliest = NO_MATCH_OFFSET;
  for (const term of significantTerms(query)) {
    const at = caseInsensitiveIndex(text, term.toLowerCase());
    if (at === NO_MATCH_OFFSET) continue;
    if (earliest === NO_MATCH_OFFSET || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * Start of a `maxChars`-wide window centred on `matchAt`, clamped to the
 * head of the text. `matchAt` at or below {@link NO_MATCH_OFFSET} is the
 * defined no-match case and yields {@link HEAD_WINDOW_START}.
 *
 * The tail is deliberately NOT clamped: a match near the end produces a
 * short window rather than one slid backwards to stay full width. That is
 * the behaviour session recall has always had, and sliding would move the
 * match away from the centre the caller is looking at.
 *
 * This is the raw centring rule, and it knows nothing about how long the
 * text is. A capped preview surface must call {@link windowStartWithin}
 * instead: this function alone will open a window past the head of a
 * passage that fitted inside the cap whole, discarding text the surface
 * had room to show.
 */
export function windowStart(matchAt: number, maxChars: number): number {
  if (matchAt <= NO_MATCH_OFFSET) return HEAD_WINDOW_START;
  return Math.max(HEAD_WINDOW_START, matchAt - Math.floor(maxChars / 2));
}

/**
 * Start of a `maxChars` window centred on `matchAt` in a text of
 * `textLength`: {@link windowStart}, plus the one bound that needs to know
 * how much text there is.
 *
 * A text that fits inside the cap whole opens at {@link HEAD_WINDOW_START}
 * and is therefore shown in full. Without this, a match past the
 * half-window slid the start forward and the surface truncated the HEAD of
 * a passage it had room to show entirely — and stamped a leading
 * continuation marker on the loss.
 *
 * `maxChars` and `textLength` must be measured in the SAME unit; which
 * unit that is stays the caller's decision, which is why this module
 * anchors windows and does not own caps. The card snippet counts code
 * points, the CLI transcript and the MCP window count UTF-16 units, and
 * each passes its own pair.
 *
 * Over-cap text is left to {@link windowStart} untouched, so a match near
 * the tail still produces a SHORT window rather than one slid backwards to
 * stay full width. Clamping the start to `textLength - maxChars` would
 * widen those windows, but it would also reverse the deliberate
 * short-window behaviour documented above and change every session-recall
 * snippet whose match sits near the end.
 */
export function windowStartWithin(matchAt: number, maxChars: number, textLength: number): number {
  if (textLength <= maxChars) return HEAD_WINDOW_START;
  return windowStart(matchAt, maxChars);
}

/** UTF-16 code units reserved for the high half of a surrogate pair. */
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
/** UTF-16 code units reserved for the low half of a surrogate pair. */
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/**
 * `utf16Offset`, moved back onto a code-point boundary when it lands on
 * the LOW half of a surrogate pair.
 *
 * A surface that slices UTF-16 units at an anchored start can open a
 * window inside an astral character (emoji, rare CJK), and the body then
 * begins with a lone low surrogate that becomes U+FFFD the moment the
 * payload is encoded as UTF-8. Backing up by one unit re-includes the high
 * half, so the character opens the window whole. The window's width is
 * measured from the returned start, so no cap is exceeded.
 *
 * An offset already on a boundary is returned unchanged, and so is a lone
 * low surrogate with no high half in front of it: the source text is
 * already ill-formed there, and inventing a pair would misrepresent it.
 * Callers that slice a code-point array (the card snippet) never need
 * this — every index into such an array is already a boundary.
 */
export function alignToCodePointStart(text: string, utf16Offset: number): number {
  if (utf16Offset <= HEAD_WINDOW_START) return utf16Offset;
  const unit = text.charCodeAt(utf16Offset);
  if (unit < LOW_SURROGATE_MIN || unit > LOW_SURROGATE_MAX) return utf16Offset;
  const previous = text.charCodeAt(utf16Offset - 1);
  if (previous < HIGH_SURROGATE_MIN || previous > HIGH_SURROGATE_MAX) return utf16Offset;
  return utf16Offset - 1;
}

/**
 * A `maxChars` window of `text` centred on the match at `index`. The
 * session-recall snippet: this is the function the three preview surfaces
 * were missing.
 *
 * Bounded by {@link windowStartWithin}, so a record shorter than
 * `maxChars` is returned whole instead of losing its head to a window
 * there was no room to move.
 */
export function snippetAround(text: string, index: number, maxChars: number): string {
  const start = windowStartWithin(index, maxChars, text.length);
  return text.slice(start, start + maxChars);
}

/**
 * Wrap a window body in continuation markers: `marker` is prefixed when
 * the window does not begin at the head of the source, and appended when
 * `hasMore` says it does not reach the end.
 *
 * A head-anchored window that covers the tail is returned unchanged,
 * which is exactly what keeps the no-match case byte-identical. Each
 * surface decides `hasMore` for itself, because each measures its cap in
 * its own units.
 */
export function markWindow(body: string, start: number, hasMore: boolean, marker: string): string {
  const head = start > HEAD_WINDOW_START ? marker : "";
  return `${head}${body}${hasMore ? marker : ""}`;
}

/**
 * Convert a UTF-16 offset into `text` to the count of CODE POINTS before
 * it, for a surface that caps its window in code points. Passes
 * {@link NO_MATCH_OFFSET} through unchanged so the sentinel survives the
 * conversion.
 */
export function toCodePointOffset(text: string, utf16Offset: number): number {
  if (utf16Offset <= NO_MATCH_OFFSET) return NO_MATCH_OFFSET;
  // `Array.from` iterates the string by code point, so a surrogate pair
  // counts once — which is the unit the caller's cap is measured in.
  return Array.from(text.slice(0, utf16Offset)).length;
}
