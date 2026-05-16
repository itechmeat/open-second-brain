import { test, expect } from "bun:test";
import { extractLinks } from "../../../src/core/search/links.ts";

test("extracts wikilinks with and without alt text", () => {
  const links = extractLinks("See [[foo-note]] and [[bar|the bar]].");
  const wikilinks = links.filter((l) => l.linkType === "wikilink");
  expect(wikilinks.length).toBe(2);
  expect(wikilinks[0]).toEqual({ linkType: "wikilink", targetPath: "foo-note", linkText: null });
  expect(wikilinks[1]).toEqual({ linkType: "wikilink", targetPath: "bar", linkText: "the bar" });
});

test("extracts relative markdown links and skips external URLs", () => {
  const text = "See [the spec](./design.md) and [Google](https://google.com).";
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]?.targetPath).toBe("./design.md");
  expect(md[0]?.linkText).toBe("the spec");
});

test("strips anchor fragments from markdown link targets", () => {
  const links = extractLinks("[Anchor](notes/x.md#section)");
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md[0]?.targetPath).toBe("notes/x.md");
});

test("extracts Obsidian-style tags including hierarchy", () => {
  const links = extractLinks("Tagged #foo and #bar/baz here. Not a tag: word#nope.");
  const tags = links.filter((l) => l.linkType === "tag").map((l) => l.linkText);
  expect(tags).toContain("foo");
  expect(tags).toContain("bar/baz");
  expect(tags).not.toContain("nope");
});

test("ignores wikilinks and tags inside fenced code blocks", () => {
  const text = `Outside [[real-link]].

\`\`\`
this is code with [[fake-link]] and #not-a-tag
\`\`\`

After fence.`;
  const links = extractLinks(text);
  const wikilinks = links.filter((l) => l.linkType === "wikilink").map((l) => l.targetPath);
  expect(wikilinks).toContain("real-link");
  expect(wikilinks).not.toContain("fake-link");
  const tags = links.filter((l) => l.linkType === "tag").map((l) => l.linkText);
  expect(tags).not.toContain("not-a-tag");
});

test("ignores wikilinks inside inline code spans", () => {
  const links = extractLinks("Inline `[[code-link]]` and real [[outside]].");
  const wikilinks = links.filter((l) => l.linkType === "wikilink").map((l) => l.targetPath);
  expect(wikilinks).toEqual(["outside"]);
});

test("deduplicates identical links from the same chunk", () => {
  const links = extractLinks("[[same]] [[same]] [[same|with alt]] #tag #tag");
  const wikilinks = links.filter((l) => l.linkType === "wikilink");
  // Two distinct: (same, null) and (same, "with alt")
  expect(wikilinks.length).toBe(2);
  const tags = links.filter((l) => l.linkType === "tag");
  expect(tags.length).toBe(1);
});

test("empty content returns empty array", () => {
  expect(extractLinks("")).toEqual([]);
});

test("skips mailto:", () => {
  const links = extractLinks("[email me](mailto:a@b.com)");
  expect(links.length).toBe(0);
});
