/**
 * Window BOUNDS, as opposed to window anchoring
 * (what-the-index-already-knew, task E follow-up).
 *
 * Anchoring answered "which offset does the window centre on". Two
 * questions it left open are defects in their own right:
 *
 * 1. A window that opens at `matchAt - half` throws away the head of a
 *    passage that ALREADY FITTED inside the cap, and stamps a leading
 *    continuation marker on the loss. The MCP surface never had the bug
 *    because it returns short content untouched before it anchors; the
 *    card snippet and the CLI transcript did.
 * 2. A window that opens at a UTF-16 offset can open INSIDE a surrogate
 *    pair, so the body begins with a lone low surrogate that renders as
 *    U+FFFD once the payload is encoded as UTF-8. This hazard is new:
 *    before anchoring, `start` was always 0.
 *
 * What must NOT change: the no-match window is still the head of the
 * chunk, byte for byte; and an over-cap passage whose match sits near the
 * tail still yields a SHORT window rather than one slid backwards to stay
 * full width, which is the behaviour session recall has always had and the
 * anchoring module states on purpose.
 */

import { describe, expect, test } from "bun:test";

import { cardSnippet } from "../../../src/core/search/cards.ts";
import { renderOutcomeHuman } from "../../../src/cli/search/outcome-render.ts";
import {
  HEAD_WINDOW_START,
  NO_MATCH_OFFSET,
  alignToCodePointStart,
  matchOffset,
  snippetAround,
  windowStart,
  windowStartWithin,
} from "../../../src/core/search/snippet-window.ts";
import type { BrainSearchResult, SearchOutcome } from "../../../src/core/search/types.ts";

/** Mirrors `CARD_SNIPPET_CHARS` in `src/core/search/cards.ts`. */
const CARD_SNIPPET_CHARS = 240;
/** Mirrors `CARD_ELLIPSIS` in `src/core/search/cards.ts`. */
const CARD_ELLIPSIS = "...";
/** Mirrors `SNIPPET_MAX_CHARS` in `src/cli/search/outcome-render.ts`. */
const CLI_SNIPPET_MAX_CHARS = 140;
/** Mirrors `ELLIPSIS` in `src/core/search/snippet-window.ts`. */
const CLI_ELLIPSIS = "…";
/** Indentation the CLI transcript puts before a snippet body. */
const CLI_SNIPPET_INDENT = "    ";

const ANCHOR_TERM = "entanglement";
const ABSENT_TERM = "photosynthesis";
/** One filler word plus a space, so collapse is a no-op on the fixtures. */
const FILLER_WORD = "context ";

/**
 * A passage that fits inside the CARD cap whole, with the match past the
 * half-window: 192 filler chars then the 12-char term, 204 code points
 * against a cap of 240 and a half-window of 120.
 */
const CARD_UNDER_CAP = `${FILLER_WORD.repeat(24)}${ANCHOR_TERM}`;
/** The same shape against the CLI cap: 112 + 12 = 124 against a cap of 140. */
const CLI_UNDER_CAP = `${FILLER_WORD.repeat(14)}${ANCHOR_TERM}`;

const REPLACEMENT_CHAR = "�";

/** Round-trip through UTF-8, which is what any wire encoding does. */
function utf8RoundTrip(text: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(text));
}

function resultWith(content: string): BrainSearchResult {
  return Object.freeze({
    documentId: 1,
    chunkId: 1,
    // Neither path nor title may carry the anchor term, or a transcript
    // assertion could pass on the header line alone.
    path: "physics/notes.md",
    title: "Notes",
    content,
    startLine: 1,
    endLine: 9,
    score: 1.5,
    keywordScore: 1.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze(["keyword: 1.50"]),
  });
}

function outcomeWith(content: string): SearchOutcome {
  return Object.freeze({
    results: Object.freeze([resultWith(content)]),
    warnings: Object.freeze([]),
    total: 1,
    // Neutral match quality: the window assertions never read it, and 1 is
    // what the coverage report yields when there is no term mass to weigh.
    idfWeightedCoverage: 1,
  });
}

/** The transcript line carrying the snippet body, indent stripped. */
function transcriptSnippet(content: string, query: string): string {
  const lines = renderOutcomeHuman(outcomeWith(content), false, query).split("\n");
  const line = lines.find((l) => l.startsWith(CLI_SNIPPET_INDENT) && !l.includes("line 1-9"));
  expect(line).toBeDefined();
  return line!.slice(CLI_SNIPPET_INDENT.length);
}

describe("a window never truncates text the cap had room for", () => {
  test("the fixtures really do put the match past the half-window", () => {
    expect([...CARD_UNDER_CAP].length).toBeLessThanOrEqual(CARD_SNIPPET_CHARS);
    expect(CARD_UNDER_CAP.indexOf(ANCHOR_TERM)).toBeGreaterThan(CARD_SNIPPET_CHARS / 2);
    expect(CLI_UNDER_CAP.length).toBeLessThanOrEqual(CLI_SNIPPET_MAX_CHARS);
    expect(CLI_UNDER_CAP.indexOf(ANCHOR_TERM)).toBeGreaterThan(CLI_SNIPPET_MAX_CHARS / 2);
  });

  test("the kernel opens at the head when the whole text fits the cap", () => {
    expect(windowStartWithin(200, CARD_SNIPPET_CHARS, 204)).toBe(HEAD_WINDOW_START);
    expect(windowStartWithin(120, CLI_SNIPPET_MAX_CHARS, 124)).toBe(HEAD_WINDOW_START);
    // Exactly at the cap is still "it fits".
    expect(windowStartWithin(200, CARD_SNIPPET_CHARS, CARD_SNIPPET_CHARS)).toBe(HEAD_WINDOW_START);
  });

  test("a card snippet that fits the cap keeps its head and carries no marker", () => {
    expect(cardSnippet(CARD_UNDER_CAP, ANCHOR_TERM)).toBe(CARD_UNDER_CAP);
  });

  test("a transcript snippet that fits the cap keeps its head and carries no marker", () => {
    expect(transcriptSnippet(CLI_UNDER_CAP, ANCHOR_TERM)).toBe(CLI_UNDER_CAP);
  });

  test("the same is true of the session-recall window the kernel also serves", () => {
    // 8 chars, cap 8: the whole text fits, so a match at offset 6 must not
    // slice the head off to centre a window there is no room to move.
    expect(snippetAround("abcdefgh", 6, 8)).toBe("abcdefgh");
  });
});

describe("an over-cap tail window stays short rather than sliding backwards", () => {
  test("the kernel does not clamp the start to len - maxChars", () => {
    // 402 code points, match at 390, cap 240. Sliding back would open at
    // 162 and return a full 240; the documented behaviour opens at 270 and
    // returns a short window that keeps the match near the centre.
    expect(windowStartWithin(390, CARD_SNIPPET_CHARS, 402)).toBe(390 - CARD_SNIPPET_CHARS / 2);
    expect(windowStartWithin(390, CARD_SNIPPET_CHARS, 402)).toBe(
      windowStart(390, CARD_SNIPPET_CHARS),
    );
  });

  test("the card snippet over the cap is the short tail window, leading marker only", () => {
    const content = `${"x".repeat(390)} ${ANCHOR_TERM}`;
    const points = [...content];
    const start = 391 - CARD_SNIPPET_CHARS / 2;
    const expected = `${CARD_ELLIPSIS}${points.slice(start, start + CARD_SNIPPET_CHARS).join("")}`;
    expect(cardSnippet(content, ANCHOR_TERM)).toBe(expected);
    expect([...cardSnippet(content, ANCHOR_TERM)].length).toBeLessThan(CARD_SNIPPET_CHARS);
  });
});

describe("the no-match window is still the head of the chunk, byte for byte", () => {
  /** Over-cap content so the pre-change head truncation actually cut. */
  const LONG = `${FILLER_WORD.repeat(200)}${ANCHOR_TERM}`;

  test("card: recomputed pre-change bytes", () => {
    const collapsed = LONG.replace(/\s+/g, " ").trim();
    const expected = `${[...collapsed].slice(0, CARD_SNIPPET_CHARS).join("")}${CARD_ELLIPSIS}`;
    expect(cardSnippet(LONG, ABSENT_TERM)).toBe(expected);
  });

  test("transcript: recomputed pre-change bytes", () => {
    const collapsed = LONG.trim().replace(/\s+/g, " ");
    const expected = `${collapsed.slice(0, CLI_SNIPPET_MAX_CHARS)}${CLI_ELLIPSIS}`;
    expect(transcriptSnippet(LONG, ABSENT_TERM)).toBe(expected);
  });

  test("under-cap content with no match passes through untouched on both surfaces", () => {
    expect(cardSnippet(CARD_UNDER_CAP, ABSENT_TERM)).toBe(CARD_UNDER_CAP);
    expect(transcriptSnippet(CLI_UNDER_CAP, ABSENT_TERM)).toBe(CLI_UNDER_CAP);
  });
});

describe("a card snippet declares its ceiling", () => {
  test("both markers fall outside the cap, so the body is never shortened", () => {
    const content = `${"z".repeat(400)} ${ANCHOR_TERM} ${"z".repeat(400)}`;
    const snippet = cardSnippet(content, ANCHOR_TERM);
    expect(snippet.startsWith(CARD_ELLIPSIS)).toBe(true);
    expect(snippet.endsWith(CARD_ELLIPSIS)).toBe(true);
    expect([...snippet].length).toBe(CARD_SNIPPET_CHARS + 2 * CARD_ELLIPSIS.length);
  });
});

describe("a window never opens inside a surrogate pair", () => {
  test("the kernel backs an offset off a low surrogate", () => {
    const text = "\u{1F600}\u{1F600}abc";
    // Offset 1 is the low half of the first emoji.
    expect(alignToCodePointStart(text, 1)).toBe(0);
    // Offsets that already sit on a boundary are returned unchanged.
    expect(alignToCodePointStart(text, 0)).toBe(0);
    expect(alignToCodePointStart(text, 2)).toBe(2);
    expect(alignToCodePointStart(text, 4)).toBe(4);
  });

  test("an already-lone low surrogate is left exactly where it is", () => {
    // Nothing to re-join: backing up here would invent a pair that the
    // source text does not contain.
    expect(alignToCodePointStart("\uDC00abc", 0)).toBe(0);
    expect(alignToCodePointStart("a\uDC00b", 1)).toBe(1);
  });

  test("the transcript window does not open on a lone low surrogate", () => {
    // 100 emoji (200 UTF-16 units), a space, then the term: the match sits
    // at 201, so the unaligned start is 131 - the low half of an emoji.
    const content = `${"\u{1F600}".repeat(100)} ${ANCHOR_TERM}${"b".repeat(100)}`;
    const unaligned = windowStart(matchOffset(content, ANCHOR_TERM), CLI_SNIPPET_MAX_CHARS);
    const code = content.charCodeAt(unaligned);
    expect(code).toBeGreaterThanOrEqual(0xdc00);
    expect(code).toBeLessThanOrEqual(0xdfff);

    const snippet = transcriptSnippet(content, ANCHOR_TERM);
    expect(utf8RoundTrip(snippet)).not.toContain(REPLACEMENT_CHAR);
    expect(snippet.startsWith(`${CLI_ELLIPSIS}\u{1F600}`)).toBe(true);
  });

  test("the sentinel window is unaffected by alignment", () => {
    expect(alignToCodePointStart("\u{1F600}abc", HEAD_WINDOW_START)).toBe(HEAD_WINDOW_START);
    expect(windowStartWithin(NO_MATCH_OFFSET, CARD_SNIPPET_CHARS, 10_000)).toBe(HEAD_WINDOW_START);
  });
});
