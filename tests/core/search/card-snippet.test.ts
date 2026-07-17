/**
 * `cardSnippet` truncates a layer-1 card snippet on CODE POINTS, not
 * UTF-16 units. A raw `.slice(0, 240)` can cut an astral character (emoji,
 * rare CJK) mid-surrogate-pair, shipping a lone surrogate that renders as
 * U+FFFD to the MCP `cards` disclosure surface. These fixtures place an
 * astral character exactly on the boundary and assert it survives whole.
 */

import { describe, expect, test } from "bun:test";

import { cardSnippet } from "../../../src/core/search/cards.ts";

const CARD_SNIPPET_CHARS = 240;
const REPLACEMENT_CHAR = "�";

describe("cardSnippet", () => {
  test("does not split a surrogate pair straddling the char boundary", () => {
    // 239 ASCII chars, then an emoji whose two UTF-16 units are at index
    // 239 and 240 — a raw UTF-16 slice(0, 240) would keep only the high
    // surrogate. The emoji is followed by more text so truncation fires.
    const content = "a".repeat(CARD_SNIPPET_CHARS - 1) + "😀" + "b".repeat(50);
    const snippet = cardSnippet(content);

    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet).not.toContain(REPLACEMENT_CHAR);
    // The whole emoji is retained (both code units present, none dangling).
    expect(snippet).toContain("😀");
    // Round-tripping through the code-point iterator is lossless — no lone
    // surrogate survived (a lone surrogate re-encodes to U+FFFD).
    expect([...snippet].every((cp) => cp !== REPLACEMENT_CHAR)).toBe(true);
    // Kept 240 code points of body + the "..." marker.
    expect([...snippet].length).toBe(CARD_SNIPPET_CHARS + 3);
  });

  test("returns short content unchanged (no marker, whitespace collapsed)", () => {
    expect(cardSnippet("  hello   world  ")).toBe("hello world");
    expect(cardSnippet("plain 😀 emoji")).toBe("plain 😀 emoji");
  });

  test("measures the cap in code points, not UTF-16 units", () => {
    // 240 emoji = 480 UTF-16 units but exactly 240 code points, so it is at
    // the cap and must pass through untruncated.
    const content = "😀".repeat(CARD_SNIPPET_CHARS);
    const snippet = cardSnippet(content);
    expect(snippet.endsWith("...")).toBe(false);
    expect([...snippet].length).toBe(CARD_SNIPPET_CHARS);
    expect(snippet).not.toContain(REPLACEMENT_CHAR);
  });
});
