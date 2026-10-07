/**
 * `splitRegroundParts` (recall-injection-lifecycle, t_55ee804e): splits an
 * oversized SessionStart payload into host-sized parts. Part 1 is emitted
 * at once; parts 2..n are queued for the `reground-deliver` carrier.
 */

import { describe, expect, test } from "bun:test";

import { REGROUND_MAX_PARTS, splitRegroundParts } from "../../../src/core/brain/reground-parts.ts";

/** The same join active-inject uses: non-empty blocks, blank line between. */
function join(blocks: ReadonlyArray<string>): string {
  return blocks.filter((block) => block.length > 0).join("\n\n");
}

/** A paragraph of `lines` lines, each about `width` chars, tagged for ordering checks. */
function paragraph(tag: string, lines: number, width: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(`${tag}-${i} `.padEnd(width, "x"));
  }
  return out.join("\n");
}

function makeBlock(tag: string, paragraphs: number, lines: number, width: number): string {
  const out: string[] = [];
  for (let i = 0; i < paragraphs; i += 1) out.push(paragraph(`${tag}p${i}`, lines, width));
  return out.join("\n\n");
}

/**
 * Assert the bodies are verbatim, in-order slices of `joined` that cover it
 * whole: between two bodies only the one separator a part boundary absorbs.
 */
function expectVerbatimCover(bodies: ReadonlyArray<string>, joined: string): void {
  let at = 0;
  for (const [i, body] of bodies.entries()) {
    const found = joined.indexOf(body, at);
    expect(found).toBeGreaterThanOrEqual(at);
    if (i > 0) expect(["", "\n", "\n\n"]).toContain(joined.slice(at, found));
    else expect(found).toBe(0);
    at = found + body.length;
  }
  expect(at).toBe(joined.length);
}

/** Strip the part header and the continuation or truncation trailer, leaving the body. */
function bodyOf(part: string): string {
  return part
    .replace(/^\[Open Second Brain context - part \d+ of \d+\]\n\n/, "")
    .replace(/\n\n\(continued in part \d+ of \d+\)$/, "")
    .replace(/\n\n\(context truncated: \d+ further part\(s\) not delivered\)$/, "");
}

describe("splitRegroundParts", () => {
  test("a payload that fits is one part equal to join(blocks) byte for byte", () => {
    const blocks = ["## Standing rules\n\n- a", "", "# Active\n\n- `pref-x` rule"];
    const split = splitRegroundParts(blocks, 9000, join);
    expect(split.parts).toEqual([join(blocks)]);
    expect(split.partsDropped).toBe(0);
    expect(split.overBudget).toBe(false);
    expect(split.utf16Chars).toBe(join(blocks).length);
  });

  test("an empty input is one empty part", () => {
    const split = splitRegroundParts(["", ""], 9000, join);
    expect(split.parts).toEqual([""]);
    expect(split.utf16Chars).toBe(0);
  });

  test("over the ceiling every part fits, headers and trailers included", () => {
    const blocks = [
      makeBlock("S", 4, 10, 80),
      makeBlock("C", 3, 10, 80),
      makeBlock("M", 10, 10, 80),
    ];
    const ceiling = 3000;
    const split = splitRegroundParts(blocks, ceiling, join);
    expect(split.parts.length).toBeGreaterThan(1);
    const n = split.parts.length;
    split.parts.forEach((part, index) => {
      expect(part.length).toBeLessThanOrEqual(ceiling);
      expect(part.startsWith(`[Open Second Brain context - part ${index + 1} of ${n}]\n\n`)).toBe(
        true,
      );
      if (index < n - 1) {
        expect(part.endsWith(`\n\n(continued in part ${index + 2} of ${n})`)).toBe(true);
      } else {
        expect(part).not.toContain("(continued in part");
      }
    });
    expect(split.utf16Chars).toBe(join(blocks).length);
    expect(split.overBudget).toBe(false);
  });

  test("block order is preserved and the standing block starts part 1", () => {
    const standing = makeBlock("S", 2, 5, 60);
    const blocks = [standing, makeBlock("C", 2, 5, 60), makeBlock("M", 6, 8, 60)];
    const split = splitRegroundParts(blocks, 2000, join);
    expect(bodyOf(split.parts[0]!).startsWith(standing)).toBe(true);
    const all = split.parts.map(bodyOf).join("\n");
    const order = ["Sp0-0", "Sp1-0", "Cp0-0", "Cp1-0", "Mp0-0", "Mp5-0"].map((tag) =>
      all.indexOf(tag),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order.toSorted((a, b) => a - b)).toEqual(order);
  });

  test("no content is lost or duplicated across parts", () => {
    const blocks = [makeBlock("S", 3, 6, 70), makeBlock("C", 2, 6, 70), makeBlock("M", 8, 9, 70)];
    const split = splitRegroundParts(blocks, 2500, join);
    expect(split.parts.length).toBeGreaterThan(1);
    expectVerbatimCover(split.parts.map(bodyOf), join(blocks));
  });

  test("an empty middle block adds no stray separator", () => {
    const blocks = [makeBlock("S", 3, 6, 70), "", makeBlock("M", 8, 9, 70)];
    const split = splitRegroundParts(blocks, 2500, join);
    expect(split.parts.length).toBeGreaterThan(1);
    for (const part of split.parts) expect(bodyOf(part)).not.toContain("\n\n\n");
    expectVerbatimCover(split.parts.map(bodyOf), join(blocks));
  });

  test("a payload exactly at the ceiling stays one part, byte for byte", () => {
    const blocks = [makeBlock("S", 2, 10, 80), makeBlock("M", 2, 10, 80)];
    const joined = join(blocks);
    const split = splitRegroundParts(blocks, joined.length, join);
    expect(split.parts).toEqual([joined]);
    expect(split.overBudget).toBe(false);
  });

  test("a payload one unit over the ceiling is split", () => {
    const blocks = [makeBlock("S", 2, 10, 80), makeBlock("M", 2, 10, 80)];
    const joined = join(blocks);
    const split = splitRegroundParts(blocks, joined.length - 1, join);
    expect(split.parts.length).toBeGreaterThan(1);
    expect(split.parts[0]!.startsWith("[Open Second Brain context - part 1 of ")).toBe(true);
    expectVerbatimCover(split.parts.map(bodyOf), joined);
  });

  test("a zero or negative ceiling terminates, keeps every unit and flags over budget", () => {
    for (const ceiling of [0, -5]) {
      const split = splitRegroundParts(["abcdef"], ceiling, join);
      expect(split.overBudget).toBe(true);
      expect(split.parts.length).toBeLessThanOrEqual(REGROUND_MAX_PARTS);
      expect(split.parts.length + split.partsDropped).toBe(3);
    }
  });

  test("a part longer than the ceiling flags over budget with nothing dropped", () => {
    // Below the frame reserve every framed part outgrows the ceiling.
    const split = splitRegroundParts(["abcdefghijkl"], 10, join);
    expect(split.partsDropped).toBe(0);
    expect(split.overBudget).toBe(true);
  });

  test("a caller's separator joins blocks on the multi-part path too", () => {
    const separator = "\n---\n";
    const joinWith = (blocks: ReadonlyArray<string>) =>
      blocks.filter((block) => block.length > 0).join(separator);
    const blocks = [paragraph("A", 5, 60), paragraph("B", 5, 60), "y".repeat(2500)];
    const split = splitRegroundParts(blocks, 2000, joinWith, separator);
    expect(split.parts.length).toBeGreaterThan(1);
    expect(bodyOf(split.parts[0]!)).toBe(paragraph("A", 5, 60) + separator + paragraph("B", 5, 60));
  });

  test("a block that fits a part is never split across parts", () => {
    const small = makeBlock("C", 1, 5, 60); // ~300 chars
    const blocks = [makeBlock("S", 1, 25, 60), small, makeBlock("M", 1, 25, 60)];
    const split = splitRegroundParts(blocks, 2000, join);
    const holders = split.parts.filter((part) => part.includes("Cp0-"));
    expect(holders.length).toBe(1);
    expect(holders[0]).toContain(small);
  });

  test("an oversized block splits at a paragraph boundary before a line boundary", () => {
    // Two paragraphs of ~1200 chars each: neither block fits 2000, each paragraph does.
    const blocks = [makeBlock("M", 2, 20, 60)];
    const split = splitRegroundParts(blocks, 2000, join);
    expect(split.parts.length).toBe(2);
    expect(bodyOf(split.parts[0]!)).toBe(paragraph("Mp0", 20, 60));
    expect(bodyOf(split.parts[1]!)).toBe(paragraph("Mp1", 20, 60));
  });

  test("an oversized paragraph splits at a line boundary", () => {
    const blocks = [paragraph("L", 60, 60)]; // one paragraph, ~3660 chars
    const split = splitRegroundParts(blocks, 2000, join);
    expect(split.parts.length).toBeGreaterThan(1);
    for (const part of split.parts) {
      for (const line of bodyOf(part).split("\n")) expect(line).toMatch(/^L-\d+ x+$/);
    }
  });

  test("a single 30,000-char line is hard-cut", () => {
    const line = "y".repeat(30_000);
    const split = splitRegroundParts([line], 9000, join);
    expect(split.parts.length).toBe(4);
    for (const part of split.parts) expect(part.length).toBeLessThanOrEqual(9000);
    expect(split.parts.map(bodyOf).join("")).toBe(line);
    expect(split.partsDropped).toBe(0);
    expect(split.overBudget).toBe(false);
  });

  test("more than REGROUND_MAX_PARTS parts drops the rest and flags over budget", () => {
    const line = "z".repeat(40_000);
    const split = splitRegroundParts([line], 2000, join);
    expect(split.parts.length).toBe(REGROUND_MAX_PARTS);
    expect(split.partsDropped).toBeGreaterThan(0);
    expect(split.overBudget).toBe(true);
    const n = REGROUND_MAX_PARTS;
    expect(split.parts[0]!.startsWith(`[Open Second Brain context - part 1 of ${n}]`)).toBe(true);
    expect(split.parts[n - 1]).not.toContain("(continued in part");
    expect(split.utf16Chars).toBe(40_000);
  });

  test("the last part names the dropped parts and every part fits the ceiling", () => {
    const line = "z".repeat(40_000);
    const split = splitRegroundParts([line], 2000, join);
    expect(split.partsDropped).toBeGreaterThan(0);
    const last = split.parts.at(-1)!;
    expect(
      last.endsWith(`\n\n(context truncated: ${split.partsDropped} further part(s) not delivered)`),
    ).toBe(true);
    for (const part of split.parts) expect(part.length).toBeLessThanOrEqual(2000);
  });

  test("droppedChars is the joined tail the kept parts did not carry", () => {
    const blocks = [makeBlock("S", 4, 10, 80), makeBlock("M", 40, 10, 80)];
    const joined = join(blocks);
    const split = splitRegroundParts(blocks, 2000, join);
    expect(split.partsDropped).toBeGreaterThan(0);
    const delivered = joined.slice(0, joined.length - split.droppedChars);
    expect(delivered.endsWith(bodyOf(split.parts.at(-1)!))).toBe(true);
    expect(joined.slice(delivered.length).startsWith("\n")).toBe(true);
  });

  test("droppedChars is 0 when every part is kept", () => {
    const blocks = [makeBlock("S", 4, 10, 80), makeBlock("M", 8, 10, 80)];
    expect(splitRegroundParts(blocks, 4000, join).droppedChars).toBe(0);
    expect(splitRegroundParts(["short"], 4000, join).droppedChars).toBe(0);
  });

  test("a split that keeps every part carries no truncation line", () => {
    const blocks = [makeBlock("S", 4, 10, 80), makeBlock("M", 8, 10, 80)];
    const split = splitRegroundParts(blocks, 4000, join);
    expect(split.parts.length).toBeGreaterThan(1);
    expect(split.partsDropped).toBe(0);
    expect(split.parts.at(-1)).not.toContain("(context truncated:");
  });

  test("astral characters are never cut in half", () => {
    const line = "\u{1F600}".repeat(5_000); // 10,000 UTF-16 units, all surrogate pairs
    // Odd capacity (ceiling minus the frame reserve), so a naive hard cut
    // would land inside a pair.
    const split = splitRegroundParts([line], 2002, join);
    for (const part of split.parts) {
      const body = bodyOf(part);
      expect(body.length % 2).toBe(0);
      expect(/[\uD800-\uDBFF]$/.test(body)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(body)).toBe(false);
      expect(part.length).toBeLessThanOrEqual(2002);
    }
    expect(split.parts.map(bodyOf).join("")).toBe(line);
  });

  test("utf16Chars equals join(blocks).length", () => {
    const blocks = ["\u{1F600}abc", "", "def"];
    expect(splitRegroundParts(blocks, 9000, join).utf16Chars).toBe(join(blocks).length);
  });
});
