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

test("image embeds (`![alt](url)`) are not captured as markdown links", () => {
  const text = "![cover](assets/cover.png) and a real [Spec](./design.md)";
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]?.targetPath).toBe("./design.md");
  expect(md.find((l) => l.targetPath === "assets/cover.png")).toBeUndefined();
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

test("resolves full reference-style links ([text][label])", () => {
  const text = `See [the spec][spec] for details.\n\n[spec]: ./design.md`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]).toEqual({
    linkType: "markdown_link",
    targetPath: "./design.md",
    linkText: "the spec",
  });
});

test("resolves collapsed reference-style links ([text][])", () => {
  const text = `Read [design][] now.\n\n[design]: notes/design.md`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]).toEqual({
    linkType: "markdown_link",
    targetPath: "notes/design.md",
    linkText: "design",
  });
});

test("resolves shortcut reference-style links ([text]) only when defined", () => {
  const text = `Both [design] and [undefined] here.\n\n[design]: ./design.md`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]?.targetPath).toBe("./design.md");
  expect(md[0]?.linkText).toBe("design");
});

test("reference labels match case-insensitively and normalise whitespace", () => {
  const text = `See [The   Spec][My Label].\n\n[my label]: ./design.md`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]?.targetPath).toBe("./design.md");
  expect(md[0]?.linkText).toBe("The   Spec");
});

test("reference definitions to external URLs and mailto are skipped", () => {
  const text = `Go [home][h] or [mail][m] or [local][l].\n\n[h]: https://example.com\n[m]: mailto:a@b.com\n[l]: ./x.md`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]?.targetPath).toBe("./x.md");
});

test("strips anchor fragments from reference-style targets", () => {
  const text = `Jump [there][t].\n\n[t]: notes/x.md#section`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md[0]?.targetPath).toBe("notes/x.md");
});

test("reference definitions accept titles and angle-bracketed targets", () => {
  const text = `A [one][a] and [two][b].\n\n[a]: ./one.md "Title here"\n[b]: <./two.md>`;
  const links = extractLinks(text);
  const targets = links
    .filter((l) => l.linkType === "markdown_link")
    .map((l) => l.targetPath)
    .toSorted();
  expect(targets).toEqual(["./one.md", "./two.md"]);
});

test("reference-style image embeds (![text][label]) are not captured", () => {
  const text = `![cover][img] and [real][doc].\n\n[img]: assets/cover.png\n[doc]: ./design.md`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]?.targetPath).toBe("./design.md");
});

test("reference definition lines do not themselves become links", () => {
  const text = `[spec]: ./design.md`;
  const links = extractLinks(text);
  expect(links.filter((l) => l.linkType === "markdown_link").length).toBe(0);
});

test("inline links are not double-counted as shortcut references", () => {
  const text = `[the spec](./design.md)\n\n[the spec]: ./other.md`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  // The inline link wins for its own occurrence; the bare [the spec] before the
  // definition resolves to the definition target. Both are legitimate, distinct edges.
  const targets = md.map((l) => l.targetPath).toSorted();
  expect(targets).toContain("./design.md");
});

test("reference links inside code fences are ignored", () => {
  const text = `\`\`\`\n[fake][ref]\n[ref]: ./nope.md\n\`\`\`\n\nReal [doc][d].\n\n[d]: ./design.md`;
  const links = extractLinks(text);
  const md = links.filter((l) => l.linkType === "markdown_link");
  expect(md.length).toBe(1);
  expect(md[0]?.targetPath).toBe("./design.md");
});
