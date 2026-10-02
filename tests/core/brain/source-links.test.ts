/**
 * Shared source-link readers: the frontmatter list reader and the wikilink
 * target extractor `source-cleanup.ts` has always used, plus the `## Sources`
 * section reader the capture-scope detector needs. One implementation, so
 * the cleanup and the detector cannot disagree about what a page cites.
 */

import { describe, expect, test } from "bun:test";

import type { FrontmatterMap } from "../../../src/core/types.ts";

import {
  sourcesSectionTargets,
  stringArrayField,
  wikilinkTarget,
} from "../../../src/core/brain/source-links.ts";

describe("stringArrayField", () => {
  test("returns the string members of a list field", () => {
    // A hand-edited page can hold anything in a list; the parser's type does not.
    const mixed = { source: ["[[a.md]]", 3, "b", null] } as unknown as FrontmatterMap;
    expect(stringArrayField(mixed, "source")).toEqual(["[[a.md]]", "b"]);
  });

  test("a scalar or an absent field reads as empty", () => {
    expect(stringArrayField({ source: "[[a.md]]" }, "source")).toEqual([]);
    expect(stringArrayField({}, "source")).toEqual([]);
  });
});

describe("wikilinkTarget", () => {
  test.each([
    ["[[Articles/a.md]]", "Articles/a.md"],
    ["[[Articles/a.md|An alias]]", "Articles/a.md"],
    ["[[Articles/a.md#Heading]]", "Articles/a.md"],
    ["[[Articles/a.md#^block1]]", "Articles/a.md"],
    ["  [[ Articles/a ]]  ", "Articles/a"],
    ["https://example.test/a", "https://example.test/a"],
    ["  plain  ", "plain"],
  ])("%p -> %p", (raw, target) => {
    expect(wikilinkTarget(raw)).toBe(target);
  });
});

describe("sourcesSectionTargets", () => {
  test("reads the bullets under ## Sources and stops at the next heading", () => {
    const body = [
      "# Title",
      "",
      "- [[Not/a-source.md]]",
      "",
      "## Sources",
      "",
      "- [[Articles/a.md]]",
      "- [[https://example.test/x|x]]",
      "",
      "## Premises (stated)",
      "",
      "- [[fact-1]]",
    ].join("\n");

    expect(sourcesSectionTargets(body)).toEqual(["Articles/a.md", "https://example.test/x"]);
  });

  test("a body without the section has no targets", () => {
    expect(sourcesSectionTargets("# Title\n\n- [[Articles/a.md]]\n")).toEqual([]);
  });

  test("CRLF bodies and several links on one line are read", () => {
    const body = "## Sources\r\n\r\n- [[a.md]], [[b.md#h]]\r\n## Next\r\n- [[c.md]]\r\n";
    expect(sourcesSectionTargets(body)).toEqual(["a.md", "b.md"]);
  });

  test("a deeper heading inside the section ends it too", () => {
    expect(sourcesSectionTargets("## Sources\n- [[a.md]]\n### Sub\n- [[b.md]]\n")).toEqual([
      "a.md",
    ]);
  });
});
