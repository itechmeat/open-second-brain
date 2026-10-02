/**
 * The extraction dispatch: one exhaustive switch over the registry's
 * extractor, so every registered format answers by name - read verbatim,
 * extracted as HTML parts or a table note, or named as not extractable -
 * and an unregistered extension answers `format-unknown` before the switch.
 */

import { describe, expect, test } from "bun:test";

import { extractSource } from "../../../../src/core/brain/ingest/extract-source.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("extractSource", () => {
  test("a text source is read verbatim", () => {
    expect(extractSource("Notes/a.md", utf8("# A\n"))).toEqual({
      extractor: "verbatim",
      format: "text",
      reason: "format-read-verbatim",
    });
  });

  test("an HTML source runs the HTML extractor", () => {
    const res = extractSource("Clips/page.HTML", utf8("<h1>Overview</h1><p>Body</p>"));
    expect(res.extractor).toBe("html");
    expect(res.format).toBe("html");
    if (!("html" in res)) throw new Error("expected the html arm");
    expect(res.html.extracted).toBe(true);
    if (!res.html.extracted) throw new Error("expected an extraction");
    expect(res.html.parts.map((p) => p.heading)).toEqual(["Overview"]);
  });

  test("a CSV source runs the table extractor", () => {
    const res = extractSource("Clips/parts.csv", utf8("name,qty\nbolt,4\nnut,7\n"));
    expect(res.extractor).toBe("table");
    expect(res.format).toBe("csv");
    if (!("table" in res)) throw new Error("expected the table arm");
    expect(res.table.rendered).toBe(true);
    if (!res.table.rendered) throw new Error("expected a rendering");
    expect([res.table.columns, res.table.rows]).toEqual([2, 2]);
  });

  test("a PDF source is named as not extractable", () => {
    expect(extractSource("Clips/report.pdf", utf8("%PDF-1.7\n"))).toEqual({
      extractor: null,
      format: "pdf",
      reason: "format-not-extractable",
    });
  });

  test("an unregistered extension is format-unknown with no format", () => {
    expect(extractSource("Clips/blob.xyz", utf8("abc"))).toEqual({
      extractor: null,
      format: null,
      reason: "format-unknown",
    });
    expect(extractSource("Clips/README", utf8("abc"))).toEqual({
      extractor: null,
      format: null,
      reason: "format-unknown",
    });
  });

  test("invalid UTF-8 in an HTML source is refused by name", () => {
    const res = extractSource("Clips/page.htm", new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe]));
    if (!("html" in res)) throw new Error("expected the html arm");
    expect(res.html).toEqual({ extracted: false, reason: "not-utf8" });
  });
});
