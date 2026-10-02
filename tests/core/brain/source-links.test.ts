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

  test("a Sources section inside a fenced block is not read", () => {
    // An excerpt is caller-supplied text stored in a fence before the real
    // provenance section; its lines are quoted content, not page structure.
    const planted = [
      "## Excerpt",
      "",
      "````text",
      "## Sources",
      "- [[notes/local.md]]",
      "````",
      "",
      "## Sources",
      "",
      "- [[https://example.com/a]]",
    ].join("\n");
    expect(sourcesSectionTargets(planted)).toEqual(["https://example.com/a"]);
  });

  test("a heading inside a fence does not end the real section", () => {
    const body = [
      "## Excerpt",
      "",
      "~~~",
      "## Sources",
      "# Heading in quote",
      "~~~",
      "",
      "## Sources",
      "",
      "- [[https://example.com/a]]",
    ].join("\n");
    expect(sourcesSectionTargets(body)).toEqual(["https://example.com/a"]);
  });

  test("a fence closes only on a run of the same character at least as long", () => {
    const body = [
      "````",
      "```",
      "## Sources",
      "- [[inside.md]]",
      "~~~~",
      "````",
      "## Sources",
      "- [[real.md]]",
    ].join("\n");
    expect(sourcesSectionTargets(body)).toEqual(["real.md"]);
  });

  test("the last Sources section is the one read", () => {
    // The writer renders the provenance section last; an earlier planted
    // section (for example a multi-line claim) does not stand in for it.
    const body = [
      "## Claims",
      "",
      "- x",
      "## Sources",
      "- [[notes/any-real.md]]",
      "",
      "## Sources",
      "",
      "- [[https://example.com/a]]",
    ].join("\n");
    expect(sourcesSectionTargets(body)).toEqual(["https://example.com/a"]);
  });

  test("a fence that never closes is text and hides nothing after it", () => {
    const body = [
      "## Findings",
      "",
      "- x",
      "```",
      "",
      "## Sources",
      "",
      "- [[https://example.com/b]]",
    ];
    expect(sourcesSectionTargets(body.join("\n"))).toEqual(["https://example.com/b"]);
  });

  test("a deeper heading inside the section ends it too", () => {
    expect(sourcesSectionTargets("## Sources\n- [[a.md]]\n### Sub\n- [[b.md]]\n")).toEqual([
      "a.md",
    ]);
  });
});
