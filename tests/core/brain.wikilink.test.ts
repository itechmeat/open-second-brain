import { describe, expect, test } from "bun:test";

import {
  MAX_PREF_LINK_TITLE_LEN,
  normaliseWikilinkTarget,
  parseArtifactRef,
  parseWikilink,
  renderPrefLink,
} from "../../src/core/brain/wikilink.ts";

describe("normaliseWikilinkTarget — existing helper", () => {
  test("strips wikilink decoration, alias, anchor, folder, .md", () => {
    expect(normaliseWikilinkTarget("[[Folder/file.md|Alias]]")).toBe("file");
    expect(normaliseWikilinkTarget("[[file#section]]")).toBe("file");
  });
});

describe("parseWikilink", () => {
  test("returns target only when input is exactly a wikilink", () => {
    expect(parseWikilink("[[foo]]")).toBe("foo");
    expect(parseWikilink("see [[foo]]")).toBeNull();
    expect(parseWikilink("foo")).toBeNull();
  });
});

describe("parseArtifactRef — bare wikilink", () => {
  test("returns target with no range", () => {
    const r = parseArtifactRef("[[file]]");
    expect(r.target).toBe("file");
    expect(r.range).toBeUndefined();
    expect(r.malformedRange).toBeUndefined();
  });

  test("normalises folder / .md / alias / anchor", () => {
    expect(parseArtifactRef("[[Folder/file.md|Alias]]").target).toBe("file");
    expect(parseArtifactRef("[[file#section]]").target).toBe("file");
  });

  test("accepts bare text (no `[[…]]`) as a target", () => {
    expect(parseArtifactRef("blog-post").target).toBe("blog-post");
  });
});

describe("parseArtifactRef — well-formed ranges", () => {
  test("colon-N-N parses to inclusive range", () => {
    const r = parseArtifactRef("[[file:120-145]]");
    expect(r.target).toBe("file");
    expect(r.range).toEqual({ start: 120, end: 145 });
    expect(r.malformedRange).toBeUndefined();
    expect(r.rangeText).toBe("120-145");
  });

  test("colon-N (single line) parses to start === end", () => {
    const r = parseArtifactRef("[[file:42]]");
    expect(r.range).toEqual({ start: 42, end: 42 });
  });

  test("range works with folder + .md", () => {
    const r = parseArtifactRef("[[src/feature.ts:10-20]]");
    expect(r.target).toBe("feature.ts");
    expect(r.range).toEqual({ start: 10, end: 20 });
  });

  test("range survives alias suffix", () => {
    const r = parseArtifactRef("[[file:10-20|Excerpt]]");
    expect(r.target).toBe("file");
    expect(r.range).toEqual({ start: 10, end: 20 });
  });
});

describe("parseArtifactRef — malformed ranges", () => {
  test("non-numeric range marks malformedRange", () => {
    const r = parseArtifactRef("[[file:abc-def]]");
    expect(r.target).toBe("file");
    expect(r.malformedRange).toBe(true);
    expect(r.range).toBeUndefined();
    expect(r.rangeText).toBe("abc-def");
  });

  test("reversed start/end marks malformedRange", () => {
    const r = parseArtifactRef("[[file:120-100]]");
    expect(r.target).toBe("file");
    expect(r.range).toBeUndefined();
    expect(r.malformedRange).toBe(true);
    expect(r.rangeText).toBe("120-100");
  });

  test("zero-start marks malformedRange (lines are 1-based)", () => {
    const r = parseArtifactRef("[[file:0-10]]");
    expect(r.malformedRange).toBe(true);
  });

  test("dangling dash marks malformedRange", () => {
    const r = parseArtifactRef("[[file:120-]]");
    expect(r.malformedRange).toBe(true);
  });

  test("empty range marks malformedRange", () => {
    const r = parseArtifactRef("[[file:]]");
    expect(r.target).toBe("file");
    expect(r.malformedRange).toBe(true);
    expect(r.range).toBeUndefined();
    expect(r.rangeText).toBe("");
  });
});

describe("parseArtifactRef — raw is preserved", () => {
  test("raw equals the original input verbatim", () => {
    const input = "[[file:120-145]]";
    expect(parseArtifactRef(input).raw).toBe(input);
  });

  test("raw equals the original even on malformed range", () => {
    const input = "[[file:120-100]]";
    expect(parseArtifactRef(input).raw).toBe(input);
  });
});

describe("renderPrefLink", () => {
  test("renders bare id when principle missing", () => {
    expect(renderPrefLink({ id: "pref-foo" })).toBe("[[pref-foo]]");
  });

  test("renders bare id when principle is undefined", () => {
    expect(renderPrefLink({ id: "pref-foo", principle: undefined })).toBe("[[pref-foo]]");
  });

  test("renders titled link for a non-empty principle", () => {
    expect(renderPrefLink({ id: "pref-foo", principle: "Prefer the calm option" })).toBe(
      "[[pref-foo|Prefer the calm option]]",
    );
  });

  test("strips wikilink-breaking characters (brackets and pipe)", () => {
    expect(renderPrefLink({ id: "pref-foo", principle: "Use [brackets] | here" })).toBe(
      "[[pref-foo|Use brackets here]]",
    );
  });

  test("collapses internal whitespace and trims edges", () => {
    expect(renderPrefLink({ id: "pref-foo", principle: "  a\n\tb   c  " })).toBe(
      "[[pref-foo|a b c]]",
    );
  });

  test("normalises NFC across visually identical inputs", () => {
    const composed = renderPrefLink({ id: "pref-foo", principle: "née" });
    const decomposed = renderPrefLink({
      id: "pref-foo",
      principle: "née",
    });
    expect(composed).toBe(decomposed);
  });

  test("falls back to bare id when the sanitised title is empty", () => {
    expect(renderPrefLink({ id: "pref-foo", principle: "[]|" })).toBe("[[pref-foo]]");
  });

  test("falls back to bare id on whitespace-only principle", () => {
    expect(renderPrefLink({ id: "pref-foo", principle: "   \n\t  " })).toBe("[[pref-foo]]");
  });

  test("renders unchanged when title length equals the cap exactly", () => {
    const exact = "x".repeat(MAX_PREF_LINK_TITLE_LEN);
    expect(renderPrefLink({ id: "pref-foo", principle: exact })).toBe(`[[pref-foo|${exact}]]`);
  });

  test("truncates at a previous-word boundary with ellipsis when possible", () => {
    const long =
      "one two three four five six seven eight nine ten eleven twelve " +
      "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
    const link = renderPrefLink({ id: "pref-foo", principle: long });
    expect(link.startsWith("[[pref-foo|")).toBe(true);
    expect(link.endsWith("…]]")).toBe(true);
    const title = link.slice("[[pref-foo|".length, -"]]".length);
    // Ellipsis is one character; title before it is constrained to the cap.
    expect(title.length).toBeLessThanOrEqual(MAX_PREF_LINK_TITLE_LEN + 1);
    // The cut should not split a word — the char before the ellipsis is a
    // letter, and there was a space inside the truncation window we backed
    // off to.
    expect(title.endsWith(" …")).toBe(false);
  });

  test("hard-cuts at the cap when no word boundary fits in the window", () => {
    const oneLongWord = "x".repeat(MAX_PREF_LINK_TITLE_LEN + 20);
    const link = renderPrefLink({ id: "pref-foo", principle: oneLongWord });
    expect(link).toBe(`[[pref-foo|${"x".repeat(MAX_PREF_LINK_TITLE_LEN)}…]]`);
  });

  test("renders for retired ids unchanged in shape", () => {
    expect(renderPrefLink({ id: "ret-bar", principle: "Old rule" })).toBe("[[ret-bar|Old rule]]");
  });

  test("renders preference references as Markdown links when requested", () => {
    expect(
      renderPrefLink({
        id: "pref-foo",
        principle: "Prefer the calm option",
        format: "markdown",
      }),
    ).toBe("[Prefer the calm option](Brain/preferences/pref-foo.md)");
  });

  test("renders retired references as Markdown links when requested", () => {
    expect(renderPrefLink({ id: "ret-bar", principle: "Old rule", format: "markdown" })).toBe(
      "[Old rule](Brain/retired/ret-bar.md)",
    );
  });

  test("uses the id as Markdown label when the title sanitises empty", () => {
    expect(renderPrefLink({ id: "pref-foo", principle: "[]|", format: "markdown" })).toBe(
      "[pref-foo](Brain/preferences/pref-foo.md)",
    );
  });

  test("encodes custom Markdown link targets", () => {
    expect(
      renderPrefLink({
        id: "pref-foo",
        principle: "Custom target",
        format: "markdown",
        targetPath: "Brain/custom path/pref-foo).md",
      }),
    ).toBe("[Custom target](Brain/custom%20path/pref-foo%29.md)");
  });

  test("MAX_PREF_LINK_TITLE_LEN is a positive integer", () => {
    expect(MAX_PREF_LINK_TITLE_LEN).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_PREF_LINK_TITLE_LEN)).toBe(true);
  });

  test("strips C0 control characters from the title", () => {
    // NUL + bell + DC1 between two visible words.
    const link = renderPrefLink({
      id: "pref-foo",
      principle: "alpha beta",
    });
    expect(link).toBe("[[pref-foo|alpha beta]]");
  });

  test("strips zero-width + BiDi-override characters", () => {
    // U+200B zero-width space, U+202E right-to-left override,
    // U+FEFF BOM — all classic visual-spoofing payloads.
    const link = renderPrefLink({
      id: "pref-foo",
      principle: "safe​word‮text﻿end",
    });
    expect(link).toBe("[[pref-foo|safe word text end]]");
  });

  test("hard-cuts on a code-point boundary (never splits a surrogate pair)", () => {
    // Each "🤖" is one Unicode scalar but two UTF-16 code units. Build
    // a string of MAX+10 robots; truncation must land on a complete
    // emoji, not a lone surrogate before the ellipsis.
    const robot = "🤖";
    const principle = robot.repeat(MAX_PREF_LINK_TITLE_LEN + 10);
    const link = renderPrefLink({ id: "pref-foo", principle });
    // Strip the prefix/suffix and inspect the title body.
    const title = link.slice("[[pref-foo|".length, -"]]".length);
    // The title must end with "…" preceded by a complete robot, not by
    // a lone high-surrogate. Splitting Array.from(title) by code point
    // and checking the last non-ellipsis codepoint is exactly one
    // robot proves the cut respected the boundary.
    const points = Array.from(title);
    expect(points[points.length - 1]).toBe("…");
    expect(points[points.length - 2]).toBe(robot);
  });
});
