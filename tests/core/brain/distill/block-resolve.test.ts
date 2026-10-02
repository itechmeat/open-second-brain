/**
 * Block resolver: an Obsidian block id (`^id`) to the text of the block it
 * marks inside the source bytes. Pure; the quote check compares a quoted span
 * against what this returns.
 */

import { describe, expect, test } from "bun:test";

import {
  indexBlocks,
  lookupBlock,
  resolveBlock,
} from "../../../../src/core/brain/distill/block-resolve.ts";

describe("resolveBlock", () => {
  test("a paragraph whose last line ends in ` ^id` resolves to the whole paragraph without the marker", () => {
    const source = [
      "# Title",
      "",
      "First line of the paragraph",
      "and its second line. ^p1",
      "",
      "Another paragraph.",
    ].join("\n");
    expect(resolveBlock(source, "p1")).toEqual({
      kind: "found",
      text: "First line of the paragraph\nand its second line.",
    });
  });

  test("a list item ending in ` ^id` resolves to that item only", () => {
    const source = ["- first item", "- second item ^li", "- third item"].join("\n");
    expect(resolveBlock(source, "li")).toEqual({ kind: "found", text: "- second item" });
  });

  test("a numbered line inside a paragraph does not start a list item", () => {
    const source = "Intro line\n1999) was a year ^p1";
    expect(resolveBlock(source, "p1")).toEqual({
      kind: "found",
      text: "Intro line\n1999) was a year",
    });
  });

  test("a bullet directly under a paragraph line still starts a list", () => {
    const source = "Key points:\n- first\n- second ^li";
    expect(resolveBlock(source, "li")).toEqual({ kind: "found", text: "- second" });
  });

  test("one index answers every id exactly as resolving each id does", () => {
    const source = "Para one ^a\n\n- x ^b\n- y ^b\n\n| t |\n^c\n\n```\nz ^d\n```";
    const index = indexBlocks(source);
    for (const id of ["a", "b", "c", "d", "missing"]) {
      expect(lookupBlock(index, id)).toEqual(resolveBlock(source, id));
    }
  });

  test("a standalone `^id` line after a table resolves to the table", () => {
    const table = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");
    const source = ["Intro.", "", table, "", "^t1", "", "Outro."].join("\n");
    expect(resolveBlock(source, "t1")).toEqual({ kind: "found", text: table });
  });

  test("a standalone `^id` line after a blockquote resolves to the blockquote", () => {
    const quote = ["> quoted line one", "> quoted line two"].join("\n");
    const source = [quote, "", "^q1"].join("\n");
    expect(resolveBlock(source, "q1")).toEqual({ kind: "found", text: quote });
  });

  test("an id inside a fenced code block is not a definition", () => {
    const source = ["```", "code line ^c1", "^c2", "```", "", "~~~", "tilde ^c3", "~~~"].join("\n");
    expect(resolveBlock(source, "c1")).toEqual({ kind: "not-found" });
    expect(resolveBlock(source, "c2")).toEqual({ kind: "not-found" });
    expect(resolveBlock(source, "c3")).toEqual({ kind: "not-found" });
  });

  test("an id nobody defined is not found", () => {
    expect(resolveBlock("Plain text with no ids.\n", "abc")).toEqual({ kind: "not-found" });
  });

  test("two definitions of one id are ambiguous", () => {
    const source = ["One. ^dup", "", "Two. ^dup"].join("\n");
    expect(resolveBlock(source, "dup")).toEqual({ kind: "ambiguous" });
  });

  test("an id that is a prefix of another does not match it", () => {
    const source = ["Longer id here. ^ab", "", "Shorter id here. ^a"].join("\n");
    expect(resolveBlock(source, "ab")).toEqual({ kind: "found", text: "Longer id here." });
    expect(resolveBlock(source, "a")).toEqual({ kind: "found", text: "Shorter id here." });
    expect(resolveBlock(["Only the long one. ^ab"].join("\n"), "a")).toEqual({
      kind: "not-found",
    });
  });

  test("a caret glued to a word is not a block marker", () => {
    expect(resolveBlock("x^p1\n", "p1")).toEqual({ kind: "not-found" });
  });

  test("CRLF sources resolve exactly as LF sources do", () => {
    const lf = ["Para line one", "line two. ^p1", "", "| a |", "| - |", "", "^t1"].join("\n");
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(resolveBlock(crlf, "p1")).toEqual(resolveBlock(lf, "p1"));
    expect(resolveBlock(crlf, "t1")).toEqual(resolveBlock(lf, "t1"));
    expect(resolveBlock(crlf, "p1")).toEqual({ kind: "found", text: "Para line one\nline two." });
  });

  test("a standalone `^id` after a fenced block resolves to the fence's inner text", () => {
    const source = ["```js", "const a = 1;", "", "const b = 2;", "```", "^code1"].join("\n");
    expect(resolveBlock(source, "code1")).toEqual({
      kind: "found",
      text: "const a = 1;\n\nconst b = 2;",
    });
  });

  test("a standalone `^id` with no block above it defines nothing", () => {
    expect(resolveBlock("^lonely\n\nText.\n", "lonely")).toEqual({ kind: "not-found" });
  });
});
