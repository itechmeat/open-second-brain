import { describe, expect, test } from "bun:test";

import {
  normaliseWikilinkTarget,
  parseArtifactRef,
  parseWikilink,
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
