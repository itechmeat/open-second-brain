/**
 * The HTML extractor: a pure, linear scanner that turns the bytes of an
 * HTML file into its title, its visible text and heading-derived parts.
 * These tests pin the grammar (entities, skipped elements, private regions,
 * whitespace, line breaks), the refusals and the bound on running time.
 */

import { describe, expect, test } from "bun:test";

import { SOURCE_HASH_MAX_BYTES } from "../../../../src/core/brain/intake/source-trust.ts";
import {
  extractHtml,
  HTML_EXTRACT_MAX_SOURCE_BYTES,
  type HtmlExtraction,
} from "../../../../src/core/brain/ingest/extract-html.ts";
import { SOURCE_EXTRACT_SKIP_REASON } from "../../../../src/core/brain/ingest/source-formats.ts";
import { PRIVATE_REGION_PLACEHOLDER } from "../../../../src/core/redactor.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";

const encoder = new TextEncoder();

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

  test("a document without a title answers null", () => {
    expect(extracted("<p>x</p>").title).toBeNull();
  });

  test("comments, doctype and processing instructions are dropped", () => {
    expect(textOf("<!DOCTYPE html><?xml version='1.0'?><!-- <p>no</p> --><p>yes</p>")).toBe("yes");
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
