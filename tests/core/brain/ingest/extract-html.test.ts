/**
 * The HTML extractor: a pure, linear scanner that turns the bytes of an
 * HTML file into its title, its visible text and heading-derived parts.
 * These tests pin the grammar (entities, skipped elements, private regions,
 * whitespace, line breaks), the refusals and the bound on running time.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { SOURCE_HASH_MAX_BYTES } from "../../../../src/core/brain/intake/source-trust.ts";
import {
  extractHtml,
  HTML_EXTRACT_MAX_SOURCE_BYTES,
  HTML_HEADING_MAX_CHARS,
  HTML_PARTS_MAX,
  type HtmlExtraction,
  renderPartsSection,
} from "../../../../src/core/brain/ingest/extract-html.ts";
import { SOURCE_EXTRACT_SKIP_REASON } from "../../../../src/core/brain/ingest/source-formats.ts";
import {
  PRIVATE_REGION_PLACEHOLDER,
  REDACTION_PLACEHOLDER,
  SCAN_TRUNCATED_MARKER,
} from "../../../../src/core/redactor.ts";
import { extractTagValues, stripCode } from "../../../../src/core/tags.ts";
import { extractWikilinks } from "../../../../src/core/vault.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";

const encoder = new TextEncoder();

/** Small headings in the memory-bound probe: about 4 MiB of source. */
const OMITTED_HEADINGS = 400_000;
/**
 * The memory the probe may grow by. Building every omitted part took about
 * 850 MB on this input; the bounded scan takes about 40 MB.
 */
const SCAN_MEMORY_BOUND_BYTES = 256 * 1024 * 1024;
/** The extractor as a module URL a probe in a fresh process imports (a URL, so a Windows path works). */
const EXTRACT_HTML_MODULE = new URL(
  "../../../../src/core/brain/ingest/extract-html.ts",
  import.meta.url,
).href;
/**
 * The time a source of huge headings may take. Redacting each heading
 * unwindowed took 1.1 s for one 8 MiB heading and 2.3 s for a 4 MiB title
 * and heading; the windowed pass leaves only the scan itself, about 40 ms
 * for 8 MiB, so the ceiling keeps a margin of more than 20x.
 */
const HEADING_WINDOW_CEILING_MS = 1_000;
/** The parts section of one part: heading, blank line, fence, the part line, fence. */
const RENDERED_LINES_ONE_PART = 5;

/** A URL-userinfo run of about `bytes`: the shape that made the unwindowed pass cost seconds. */
function userinfoRun(bytes: number): string {
  return "a://b:".repeat(Math.floor(bytes / 6));
}

/** The extraction of `html`, failing the test when the scanner refused it. */
function extracted(html: string): HtmlExtraction {
  const result = extractHtml(encoder.encode(html));
  if (!result.extracted) throw new Error(`extraction refused: ${result.reason}`);
  return result;
}

/** An extraction without its byte offsets, which differ between line-ending styles. */
function withoutOffsets(x: HtmlExtraction): unknown {
  return { text: x.text, parts: x.parts.map(({ sourceOffset: _offset, ...rest }) => rest) };
}

/** The visible text of `html`. */
function textOf(html: string): string {
  return extracted(html).text;
}

describe("extractHtml - text", () => {
  test("reads the cap from the source hash ceiling", () => {
    expect(HTML_EXTRACT_MAX_SOURCE_BYTES).toBe(SOURCE_HASH_MAX_BYTES);
  });

  test("block elements break lines, inline elements do not", () => {
    expect(
      textOf("<html><body><h1>Overview</h1><p>Fish <b>and</b> chips</p><div>Run it.</div></body>"),
    ).toBe("Overview\nFish and chips\nRun it.");
  });

  test("decodes numeric entities and turns an invalid code point into U+FFFD", () => {
    expect(textOf("<p>&#65;&#x42;&#X43;&#0;&#xD800;&#x110000;</p>")).toBe("ABC���");
  });

  test("decodes the six named entities and keeps any other named entity verbatim", () => {
    expect(textOf("<p>&amp; &lt; &gt; &quot; &apos; a&nbsp;b &copy; &unknownthing;</p>")).toBe(
      "& < > \" ' a b &copy; &unknownthing;",
    );
  });

  test("a bare ampersand and a stray less-than are text", () => {
    expect(textOf("<p>salt & pepper, 1 < 2, a <3 b, &#;</p>")).toBe(
      "salt & pepper, 1 < 2, a <3 b, &#;",
    );
  });

  test("raw-text and skipped elements contribute no text", () => {
    const html = [
      "<p>before</p>",
      "<script>var x = '<p>not text</p>';</script>",
      "<style>p { color: red }</style>",
      "<noscript><p>enable scripts</p></noscript>",
      "<template><p>template</p></template>",
      "<svg><title>icon</title><text>svg text</text></svg>",
      "<math><mi>x</mi></math>",
      "<p>after</p>",
    ].join("");
    expect(textOf(html)).toBe("before\nafter");
  });

  test("a script whose body names another end tag stays skipped to its own end tag", () => {
    expect(textOf("<script>document.write('</div></scr' + 'ipt>')</script ><p>shown</p>")).toBe(
      "shown",
    );
  });

  test("a private region becomes the placeholder", () => {
    expect(textOf("<p>visible <private>hidden <h2>also hidden</h2> words</private> tail</p>")).toBe(
      `visible ${PRIVATE_REGION_PLACEHOLDER} tail`,
    );
  });

  test("a private region inside a heading stays out of the text and the part", () => {
    const result = extracted("<h1>Plan <private>vault 4711</private> v2</h1><p>body</p>");
    expect(result.text).toBe(`Plan ${PRIVATE_REGION_PLACEHOLDER} v2\nbody`);
    expect(result.parts.map((p) => p.heading)).toEqual([`Plan ${PRIVATE_REGION_PLACEHOLDER} v2`]);
    expect(renderPartsSection(result)).not.toContain("4711");
    const unclosed = extracted("<h2>Plan <private>vault 4711</h2><p>after</p>");
    expect(JSON.stringify(unclosed)).not.toContain("4711");
    expect(JSON.stringify(unclosed)).not.toContain("after");
  });

  test("a private region inside a title or a textarea is not emitted", () => {
    // Title and textarea content is read as raw text, so the private-region
    // rule is applied to that text as well; the title reaches the CLI preview.
    const titled = extracted("<title>Plan <private>vault 4711</private></title><p>x</p>");
    expect(titled.title).toBe(`Plan ${PRIVATE_REGION_PLACEHOLDER}`);
    const area = extracted("<textarea>a <private>vault 4711</private> b</textarea>");
    expect(area.text).toBe(`a ${PRIVATE_REGION_PLACEHOLDER} b`);
    // Stripped after decoding: an entity-encoded region hides too (fail-closed).
    const encoded = extracted("<textarea>a &lt;private&gt;vault 4711&lt;/private&gt; b</textarea>");
    expect(encoded.text).toBe(`a ${PRIVATE_REGION_PLACEHOLDER} b`);
  });

  test("a private region inside a textarea in a heading stays out of the parts", () => {
    const result = extracted(
      "<h1>Ops <textarea>key <private>vault 4711</private></textarea></h1><p>x</p>",
    );
    expect(result.parts.map((p) => p.heading)).toEqual([`Ops key ${PRIVATE_REGION_PLACEHOLDER}`]);
    expect(renderPartsSection(result)).not.toContain("4711");
  });

  test("an unclosed private region hides everything after it", () => {
    expect(textOf("<p>kept</p><private><p>hidden to the end</p>")).toBe(
      `kept\n${PRIVATE_REGION_PLACEHOLDER}`,
    );
  });

  test("void elements need no end tag and br breaks a line", () => {
    expect(textOf("<p>one<br>two<br/>three<img src=x.png>four<hr>five</p>")).toBe(
      "one\ntwo\nthreefour\nfive",
    );
  });

  test("document-level text outside any element is kept", () => {
    expect(textOf("loose text <b>bold</b> more")).toBe("loose text bold more");
  });

  test("whitespace collapses outside pre and survives inside it", () => {
    expect(textOf("<p>  a \t\n  b  </p><pre>\n  x  y\n\n  z\n</pre><p>c</p>")).toBe(
      "a b\n  x  y\n\n  z\nc",
    );
  });

  test("CRLF and lone CR give the same output as LF", () => {
    const lf = "<p>a\nb</p><pre>one\ntwo\n</pre><h1>T</h1><p>end</p>";
    const crlf = lf.replaceAll("\n", "\r\n");
    const cr = lf.replaceAll("\n", "\r");
    expect(withoutOffsets(extracted(crlf))).toEqual(withoutOffsets(extracted(lf)));
    expect(withoutOffsets(extracted(cr))).toEqual(withoutOffsets(extracted(lf)));
    expect(extracted(lf).text).toBe("a b\none\ntwo\nT\nend");
  });

  test("no attribute value is ever emitted", () => {
    const credential = fakeCredential("ghp_", "attrValue0123456789abcdef");
    const html =
      `<a href="https://example.test/?k=${credential}" title='${credential}' ` +
      `data-x=${credential}>link</a><img alt="${credential}">`;
    const result = extracted(html);
    expect(result.text).toBe("link");
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  test("a quoted attribute value may hold a greater-than sign", () => {
    expect(textOf('<p title="a > b">body</p>')).toBe("body");
  });

  test("the title is captured and kept out of the text", () => {
    const result = extracted(
      "<html><head><title> Release\n notes &amp; more </title></head><body><p>x</p></body></html>",
    );
    expect(result.title).toBe("Release notes & more");
    expect(result.text).toBe("x");
  });

  test("a title is folded onto one line", () => {
    expect(extracted("<title>bell\u0007here</title>").title).toBe("bell here");
  });

  test("a document without a title answers null", () => {
    expect(extracted("<p>x</p>").title).toBeNull();
  });

  test("comments, doctype and processing instructions are dropped", () => {
    expect(textOf("<!DOCTYPE html><?xml version='1.0'?><!-- <p>no</p> --><p>yes</p>")).toBe("yes");
  });

  test.each(["<!-->", "<!--->"])("%s is an empty comment, not an open one", (comment) => {
    const x = extracted(`<p>a</p>${comment}<h1>B</h1>`);
    expect(x.text).toBe("a\nB");
    expect(x.parts.filter((part) => part.level === 1).map((part) => part.heading)).toEqual(["B"]);
  });

  test("malformed and unclosed tags never throw and never leak markup", () => {
    expect(textOf("<p>a</p><div class='open")).toBe("a");
    expect(textOf("<p>a</p><!-- never closed <p>b</p>")).toBe("a");
    expect(textOf("<p>a</p><b")).toBe("a");
    expect(textOf("<p>a</p></>text")).toBe("a\ntext");
    expect(textOf("<script>never closed <p>x</p>")).toBe("");
  });

  test("invalid UTF-8 is refused by name", () => {
    const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]);
    expect(extractHtml(bytes)).toEqual({
      extracted: false,
      reason: SOURCE_EXTRACT_SKIP_REASON.notUtf8,
    });
  });

  test("a byte-order mark is not text", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("<p>x</p>")]);
    const result = extractHtml(bom);
    expect(result.extracted && result.text).toBe("x");
  });

  test("runs in linear time on adversarial input", () => {
    const size = 1_048_576;
    const shapes = ["<a ", "<!--", "&#", "</scr", "<p title='", "&amp", "<h1>"];
    for (const shape of shapes) {
      const html = `<script>${shape.repeat(Math.ceil(size / shape.length))}`;
      const plain = shape.repeat(Math.ceil(size / shape.length));
      for (const input of [html, plain]) {
        const started = performance.now();
        extractHtml(encoder.encode(input));
        expect(performance.now() - started).toBeLessThan(2_000);
      }
    }
  });
});

/** The release-notes page of the CLI fixture (`cli-output/expected-output.md`). */
const RELEASE_NOTES =
  "<html><head><title>Release notes</title></head><body><h1>Overview</h1>" +
  "<p>Fish &amp; chips</p><h2>Install</h2><p>Run it.</p></body></html>";

describe("extractHtml - parts", () => {
  test("pins the caps", () => {
    expect(HTML_PARTS_MAX).toBe(256);
    expect(HTML_HEADING_MAX_CHARS).toBe(200);
  });

  test("the fixture page gives two parts with levels, trails, spans and start-tag offsets", () => {
    const result = extracted(RELEASE_NOTES);
    expect(result.title).toBe("Release notes");
    expect(result.text).toBe("Overview\nFish & chips\nInstall\nRun it.");
    expect(result.parts).toEqual([
      {
        index: 0,
        level: 1,
        heading: "Overview",
        trail: "Overview",
        lineStart: 1,
        lineEnd: 2,
        sourceOffset: 53,
      },
      {
        index: 1,
        level: 2,
        heading: "Install",
        trail: "Overview > Install",
        lineStart: 3,
        lineEnd: 4,
        sourceOffset: 93,
      },
    ]);
    expect(result.partsOmitted).toBe(0);
  });

  test("a heading closes the sections at its level and below", () => {
    const result = extracted(
      "<h1>A</h1><h2>B</h2><h3>C</h3><p>c</p><h2>D</h2><h1>E</h1><h3>F</h3>",
    );
    expect(result.parts.map((p) => [p.level, p.trail, p.lineStart, p.lineEnd])).toEqual([
      [1, "A", 1, 1],
      [2, "A > B", 2, 2],
      [3, "A > B > C", 3, 4],
      [2, "A > D", 5, 5],
      [1, "E", 6, 6],
      [3, "E > F", 7, 7],
    ]);
  });

  test("a source offset counts UTF-8 bytes, a byte-order mark included", () => {
    const prefix = "<p>\u00e9\u4e2d\u{1F600}</p>"; // 2 + 3 + 4 bytes of text
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...encoder.encode(`${prefix}<h2 id="x">T</h2>`),
    ]);
    const result = extractHtml(bytes);
    if (!result.extracted) throw new Error("refused");
    expect(result.parts.at(-1)?.sourceOffset).toBe(3 + encoder.encode(prefix).length);
  });

  test("a preamble part exists only when text precedes the first heading", () => {
    const withPreamble = extracted("<p>intro</p><p>more</p><h1>T</h1><p>body</p>");
    expect(withPreamble.parts[0]).toEqual({
      index: 0,
      level: 0,
      heading: "",
      trail: "",
      lineStart: 1,
      lineEnd: 2,
      sourceOffset: 0,
    });
    expect(withPreamble.parts[1]).toMatchObject({ index: 1, level: 1, lineStart: 3, lineEnd: 4 });
    expect(extracted("<h1>T</h1><p>body</p>").parts[0]?.level).toBe(1);
    expect(extracted("<p>no headings at all</p>").parts).toEqual([]);
  });

  test("an empty heading is no part and a heading inside a skipped region is none either", () => {
    const result = extracted(
      "<h1>A</h1><h2>  </h2><private><h2>secret plan</h2></private><svg><h3>x</h3></svg><p>p</p>",
    );
    expect(result.parts.map((p) => p.heading)).toEqual(["A"]);
  });

  test("a heading is folded onto one line", () => {
    expect(extracted("<h1>two<br>lines\there</h1>").parts[0]?.heading).toBe("two lines here");
  });

  test(`${HTML_PARTS_MAX + 1} headings give ${HTML_PARTS_MAX} parts and count the rest`, () => {
    const html = Array.from({ length: HTML_PARTS_MAX + 1 }, (_, n) => `<h2>H${n}</h2>`).join("");
    const result = extracted(html);
    expect(result.parts.length).toBe(HTML_PARTS_MAX);
    expect(result.partsOmitted).toBe(1);
    expect(result.parts.at(-1)?.lineEnd).toBe(HTML_PARTS_MAX);
  });

  test("a credential in a heading or a title is redacted before the cap", () => {
    const key = fakeCredential("sk-", "live-9f8e7d6c5b4a3210");
    const password = fakeCredential("hunter", "2pass");
    const result = extracted(
      `<title>api_key=${key}</title><h1>api_key=${key}</h1>` +
        `<h2>https://admin:${password}@db.example</h2>` +
        `<h3>${"x".repeat(HTML_HEADING_MAX_CHARS - 25)} https://admin:${password}@db.example</h3><p>x</p>`,
    );
    const visible = JSON.stringify({ title: result.title, parts: result.parts });
    for (const leaked of [key, password, password.slice(0, 5)])
      expect(visible).not.toContain(leaked);
    expect(result.title).toContain(REDACTION_PLACEHOLDER);
    expect(result.parts[0]?.heading).toContain(REDACTION_PLACEHOLDER);
    expect(renderPartsSection(result)).not.toContain(password);
  });

  describe("a huge heading or title is redacted in a bounded window", () => {
    const MIB = 1 << 20;
    test.each([
      [
        "one heading near the source cap",
        `<h1>${userinfoRun(HTML_EXTRACT_MAX_SOURCE_BYTES - 64)}</h1>`,
      ],
      [
        "a title and a heading",
        `<title>${userinfoRun(4 * MIB - 64)}</title><h1>${userinfoRun(4 * MIB - 64)}</h1>`,
      ],
    ])("%s", (_name, html) => {
      const started = performance.now();
      const result = extracted(html);
      expect(performance.now() - started).toBeLessThan(HEADING_WINDOW_CEILING_MS);
      expect(Array.from(result.parts[0]?.heading ?? "").length).toBe(HTML_HEADING_MAX_CHARS);
    });

    test("a credential heading past the redactor's input cap keeps its part on one line", () => {
      const result = extracted(`<h1>password=${"x".repeat(MIB + 16)}</h1><p>x</p>`);
      const trail = result.parts[0]?.trail ?? "";
      expect(trail).toContain(REDACTION_PLACEHOLDER);
      expect(trail).not.toContain("\n");
      expect(trail).not.toContain(SCAN_TRUNCATED_MARKER);
      expect(renderPartsSection(result).split("\n")).toHaveLength(RENDERED_LINES_ONE_PART);
    });

    test("a heading cut by the window is marked as cut", () => {
      const result = extracted(`<h1>password=${"x".repeat(MIB)} tail</h1>`);
      expect(result.parts[0]?.heading).toBe(`password=${REDACTION_PLACEHOLDER}…`);
    });
  });

  test.each([
    ["without a preamble", "", 300],
    ["with a preamble", "<p>intro</p>", 301],
  ])("far more headings than the cap count every omitted part (%s)", (_name, lead, partCount) => {
    const html = lead + Array.from({ length: 300 }, (_, n) => `<h2>H${n}</h2>`).join("");
    const result = extracted(html);
    expect(result.parts.length).toBe(HTML_PARTS_MAX);
    expect(result.partsOmitted).toBe(partCount - HTML_PARTS_MAX);
    expect(result.parts.at(-1)?.lineEnd).toBe(HTML_PARTS_MAX);
  });

  test("omitted parts cost no memory: many small headings under long ancestors", () => {
    // Every omitted h6 would otherwise carry a trail of about 1,000 characters.
    // Measured in a fresh process: in a shared test process the resident set
    // already holds pages freed by earlier files, which an unbounded scan
    // reuses without growing it, so an in-process probe passes either way.
    const probe = [
      `import { extractHtml } from ${JSON.stringify(EXTRACT_HTML_MODULE)};`,
      `const ancestors = [1, 2, 3, 4, 5].map((l) => \`<h\${l}>\${"a".repeat(${HTML_HEADING_MAX_CHARS - 1})}</h\${l}>\`).join("");`,
      `const bytes = new TextEncoder().encode(ancestors + "<h6>x</h6>".repeat(${OMITTED_HEADINGS}));`,
      "Bun.gc(true);",
      "const before = process.memoryUsage().rss;",
      "const result = extractHtml(bytes);",
      "const grown = process.memoryUsage().rss - before;",
      "console.log(JSON.stringify({ grown, omitted: result.extracted ? result.partsOmitted : null }));",
    ].join("\n");
    const run = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const { grown, omitted } = JSON.parse(run.stdout) as { grown: number; omitted: number };
    expect(omitted).toBe(OMITTED_HEADINGS + 5 - HTML_PARTS_MAX);
    expect(grown).toBeLessThan(SCAN_MEMORY_BOUND_BYTES);
  });

  test("a heading of astral characters is capped at a code-point boundary", () => {
    const heading =
      extracted(`<h1>${"\u{1F600}".repeat(HTML_HEADING_MAX_CHARS + 50)}</h1>`).parts[0]?.heading ??
      "";
    expect(heading).toBe(`${"\u{1F600}".repeat(HTML_HEADING_MAX_CHARS - 1)}\u2026`);
  });

  test("a 300-character heading is capped", () => {
    const heading = extracted(`<h1>${"x".repeat(300)}</h1>`).parts[0]?.heading ?? "";
    expect(Array.from(heading).length).toBe(HTML_HEADING_MAX_CHARS);
    expect(heading.endsWith("\u2026")).toBe(true);
  });
});

describe("renderPartsSection", () => {
  test("renders one fenced line per part", () => {
    expect(renderPartsSection(extracted(RELEASE_NOTES))).toBe(
      [
        "## Parts",
        "",
        "```parts",
        "h1 Overview | lines 1-2",
        "h2 Overview > Install | lines 3-4",
        "```",
      ].join("\n"),
    );
  });

  test("renders the preamble by name", () => {
    expect(renderPartsSection(extracted("<p>intro</p><h3>T</h3>"))).toBe(
      ["## Parts", "", "```parts", "preamble | lines 1-1", "h3 T | lines 2-2", "```"].join("\n"),
    );
  });

  test("a pipe in a heading is escaped so it cannot forge the span", () => {
    expect(renderPartsSection(extracted("<h1>x | lines 1-999</h1>")).split("\n")[3]).toBe(
      "h1 x \\| lines 1-999 | lines 1-1",
    );
  });

  test("a backslash before a pipe in a heading cannot unescape it", () => {
    expect(renderPartsSection(extracted("<h1>x \\| lines 1-999</h1>")).split("\n")[3]).toBe(
      "h1 x \\\\\\| lines 1-999 | lines 1-1",
    );
  });

  test("is empty when there are no parts", () => {
    expect(renderPartsSection(extracted("<p>flat</p>"))).toBe("");
  });

  test("a fence outgrows a backtick run in a heading", () => {
    const section = renderPartsSection(extracted("<h1>a ```` b</h1>"));
    expect(section.split("\n")[2]).toBe("`````parts");
    expect(section.endsWith("\n`````")).toBe(true);
  });

  test("a wikilink or a tag in a heading yields no link and no tag", () => {
    const section = renderPartsSection(extracted("<h1>See [[Target]] and #topic</h1><p>x</p>"));
    expect(section).toContain("[[Target]]");
    const cleaned = stripCode(section);
    expect(extractWikilinks(cleaned)).toEqual([]);
    expect(extractTagValues(cleaned)).toEqual([]);
  });
});
