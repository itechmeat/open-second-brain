/**
 * Match-anchored snippet windows (what-the-index-already-knew, task E).
 *
 * Every preview surface truncated from the HEAD of the chunk, so a match
 * in the middle of a long passage was invisible in the preview the caller
 * actually reads: the card snippet stopped at 240 chars, the CLI
 * transcript at 140, the MCP `content` at 600. The window is now centred
 * on the first significant query term that occurs in the content.
 *
 * The no-match case is a DEFINED behaviour, not a fallback: when no
 * significant query term occurs, the window is the head of the chunk -
 * the same bytes the head truncation produced. Both halves are asserted
 * here, the second against literally-recomputed pre-change bytes rather
 * than against the function under test.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { cardSnippet } from "../../../src/core/search/cards.ts";
import { renderOutcomeHuman } from "../../../src/cli/search/outcome-render.ts";
import {
  HEAD_WINDOW_START,
  NO_MATCH_OFFSET,
  markWindow,
  matchOffset,
  snippetAround,
  toCodePointOffset,
  windowStart,
} from "../../../src/core/search/snippet-window.ts";
import type { BrainSearchResult, SearchOutcome } from "../../../src/core/search/types.ts";

/** Mirrors `CARD_SNIPPET_CHARS` in `src/core/search/cards.ts`. */
const CARD_SNIPPET_CHARS = 240;
/** Mirrors `SNIPPET_MAX_CHARS` in `src/cli/search/outcome-render.ts`. */
const CLI_SNIPPET_MAX_CHARS = 140;

const FILLER = "This paragraph records background context for the passage. ";
/** The only sentence in the fixture carrying the anchor term. */
const MATCH_SENTENCE = "Quantum entanglement links two particles at a distance.";
/** Term present in the fixture; `significantTerms` keeps it (length >= 3). */
const ANCHOR_TERM = "entanglement";
/** Term absent from the fixture, so the window has nothing to anchor on. */
const ABSENT_TERM = "photosynthesis";

/** Filler long enough to push the match past every surface's cap. */
const LEAD = FILLER.repeat(12);
const CONTENT = `${LEAD}${MATCH_SENTENCE}\n${FILLER.repeat(12)}`;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resultWith(content: string): BrainSearchResult {
  return Object.freeze({
    documentId: 1,
    chunkId: 1,
    // Neither the path nor the title may carry the anchor term, or the
    // transcript assertion would pass on the header line alone.
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
    // Neutral match quality: the snippet assertions never read it, and 1 is
    // what the coverage report yields when there is no term mass to weigh.
    idfWeightedCoverage: 1,
  });
}

describe("the anchoring kernel", () => {
  test("no significant term occurrence is the named sentinel, not offset 0", () => {
    expect(matchOffset(CONTENT, ABSENT_TERM)).toBe(NO_MATCH_OFFSET);
    expect(NO_MATCH_OFFSET).not.toBe(HEAD_WINDOW_START);
    // A term at the very start is offset 0 and must stay distinguishable
    // from "nothing matched".
    expect(matchOffset("this leads the chunk", "this")).toBe(HEAD_WINDOW_START);
  });

  test("the sentinel window is the head of the text", () => {
    expect(windowStart(NO_MATCH_OFFSET, CARD_SNIPPET_CHARS)).toBe(HEAD_WINDOW_START);
    expect(snippetAround("abcdefgh", NO_MATCH_OFFSET, 4)).toBe("abcd");
  });

  test("a window is centred on the match and clamped at the head", () => {
    expect(windowStart(1000, 200)).toBe(900);
    expect(windowStart(10, 200)).toBe(HEAD_WINDOW_START);
  });

  test("a short term anchors a window like any other", () => {
    // There used to be a length floor here, inherited from
    // `significantTerms`, and a two-character query therefore had no
    // terms at all and anchored nothing. That floor was an English-shaped
    // stopword rule: it also erased every one- and two-character CJK
    // query, whose words are that long. With it gone, a short term is a
    // term, and the only cost is the one this module's docblock already
    // accepted - a window may open where a common word does.
    expect(matchOffset("an ox in the field", "ox")).toBe("an ox in the field".indexOf("ox"));
    expect(matchOffset("the 検索 pipeline", "検索")).toBe("the 検索 pipeline".indexOf("検索"));
    // A term genuinely absent still reports the sentinel.
    expect(matchOffset("an ox in the field", "zz")).toBe(NO_MATCH_OFFSET);
  });

  test("the earliest occurrence among several terms wins", () => {
    const text = "alpha beta gamma";
    expect(matchOffset(text, "gamma alpha")).toBe(text.indexOf("alpha"));
  });

  test("matching is case-insensitive and offsets index the original text", () => {
    const text = "The Entanglement of particles";
    expect(matchOffset(text, "ENTANGLEMENT")).toBe(text.indexOf("Entanglement"));
  });

  test("markers appear only on the sides the window does not reach", () => {
    expect(markWindow("body", HEAD_WINDOW_START, false, "…")).toBe("body");
    expect(markWindow("body", HEAD_WINDOW_START, true, "…")).toBe("body…");
    expect(markWindow("body", 5, true, "…")).toBe("…body…");
  });

  test("a code-point offset counts a surrogate pair once", () => {
    const text = "😀😀abc";
    expect(toCodePointOffset(text, text.indexOf("abc"))).toBe(2);
    expect(toCodePointOffset(text, NO_MATCH_OFFSET)).toBe(NO_MATCH_OFFSET);
  });
});

describe("match-anchored snippet windows", () => {
  test("the fixture really does place the match past every surface cap", () => {
    const at = CONTENT.indexOf(ANCHOR_TERM);
    expect(at).toBeGreaterThan(600);
    expect(CONTENT.includes(ABSENT_TERM)).toBe(false);
  });

  test("a card snippet shows a match that sits past the card cap", () => {
    const snippet = cardSnippet(CONTENT, ANCHOR_TERM);
    expect(snippet).toContain(ANCHOR_TERM);
  });

  test("the CLI transcript shows a match that sits past the transcript cap", () => {
    const rendered = renderOutcomeHuman(outcomeWith(CONTENT), false, ANCHOR_TERM);
    expect(rendered).toContain(ANCHOR_TERM);
  });

  test("no query-term occurrence: the card snippet is the head of the chunk", () => {
    const collapsed = collapse(CONTENT);
    const expected = `${[...collapsed].slice(0, CARD_SNIPPET_CHARS).join("")}...`;
    expect(cardSnippet(CONTENT, ABSENT_TERM)).toBe(expected);
  });

  test("no query-term occurrence: the CLI transcript is the head of the chunk", () => {
    const collapsed = CONTENT.trim().replace(/\s+/g, " ");
    const expected = `    ${collapsed.slice(0, CLI_SNIPPET_MAX_CHARS)}…`;
    const rendered = renderOutcomeHuman(outcomeWith(CONTENT), false, ABSENT_TERM);
    expect(rendered.split("\n")).toContain(expected);
  });
});

describe("the cards disclosure surface anchors through the real pipeline", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  test("a card snippet shows a match the head window would have cut", async () => {
    const v = createTempVault("snippet-match-anchor");
    cleanup = v.cleanup;
    // One paragraph under the 800-char chunk cap, so the whole fixture is
    // a single chunk and the match really does sit past the card cap.
    const body = `${FILLER.repeat(6)}${MATCH_SENTENCE}`;
    writeMd(v.vault, "physics/notes.md", `# Notes\n\n${body}\n`);
    const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });
    await indexVault(cfg);

    const outcome = await search(cfg, {
      query: ANCHOR_TERM,
      limit: 5,
      disclosure: "cards",
    });
    expect(outcome.cards).toBeDefined();
    const card = outcome.cards!.find((c) => c.path === "physics/notes.md");
    expect(card).toBeDefined();
    expect(body.indexOf(ANCHOR_TERM)).toBeGreaterThan(CARD_SNIPPET_CHARS);
    expect(card!.snippet).toContain(ANCHOR_TERM);
  });
});

test("the transcript marker asks about the collapsed text, not the raw chunk", () => {
  // A chunk whose RAW length is over the cap but which collapses under it
  // is not cut, so it must carry no trailing marker. Keying the marker on
  // `content.length` claimed a cut that whitespace collapse had already
  // removed - the marker said "there is more" when there was not.
  const words = "alpha beta gamma delta ".repeat(4).trim(); // 91 chars collapsed
  const padded = words.replace(/ /g, "\n\n     "); // same words, 400+ raw chars
  expect(padded.length).toBeGreaterThan(140);
  expect(padded.trim().replace(/\s+/g, " ").length).toBeLessThan(140);

  const rendered = renderOutcomeHuman(outcomeWith(padded), false, "alpha");
  expect(rendered).toContain("alpha beta gamma delta");
  expect(rendered).not.toContain("…");
});
