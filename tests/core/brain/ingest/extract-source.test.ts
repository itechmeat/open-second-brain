/**
 * The extraction dispatch: one exhaustive switch over the registry's
 * extractor, so every registered format answers by name - read verbatim,
 * extracted as HTML parts or a table note, or named as not extractable -
 * and an unregistered extension answers `format-unknown` before the switch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveSourceSection,
  extractSource,
} from "../../../../src/core/brain/ingest/extract-source.ts";
import { LINEAR_CEILING_MS } from "../../../helpers/linear-time.ts";
import { SOURCE_HASH_MAX_BYTES } from "../../../../src/core/brain/intake/source-trust.ts";
import { INTAKE_TRUST } from "../../../../src/core/brain/trust/untrusted-provenance.ts";

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

/** A source whose own frontmatter reserves it, ahead of its data. */
const RESERVED_CSV = "---\nvisibility: private\n---\nname,code\nvault,4711\n";
const RESERVED_HTML = "---\nvisibility: private\n---\n<h1>Vault plan</h1><p>4711</p>\n";

describe("a leading frontmatter block is not source data", () => {
  test("a CSV renders the records after the block, the header first", () => {
    const res = extractSource("Clips/h.csv", utf8(RESERVED_CSV));
    if (!("table" in res) || !res.table.rendered) throw new Error("expected a rendering");
    expect([res.table.columns, res.table.rows]).toEqual([2, 1]);
    expect(res.table.section).toContain("name | code\nvault | 4711\n");
    expect(res.table.section).not.toContain("---");
    expect(res.table.section).not.toContain("visibility");
  });

  test("a byte-order mark and CRLF line ends do not hide the block", () => {
    const res = extractSource(
      "Clips/h.csv",
      utf8(`\uFEFF${RESERVED_CSV.replaceAll("\n", "\r\n")}`),
    );
    if (!("table" in res) || !res.table.rendered) throw new Error("expected a rendering");
    expect([res.table.columns, res.table.rows]).toEqual([2, 1]);
    expect(res.table.section).not.toContain("visibility");
  });

  test("an HTML source renders no block text and no preamble part for it", () => {
    const res = extractSource("Clips/h.html", utf8(RESERVED_HTML));
    if (!("html" in res) || !res.html.extracted) throw new Error("expected an extraction");
    expect(res.html.text).not.toContain("visibility");
    expect(res.html.parts.map((p) => p.heading)).toEqual(["Vault plan"]);
  });

  test.each([
    ["no mark", "", 25],
    ["a byte-order mark", "\uFEFF", 28],
  ])("a part's offset counts the bytes of the left-out block (%s)", (_label, mark, offset) => {
    const res = extractSource(
      "Clips/h.html",
      utf8(`${mark}---\nvisibility: team\n---\n<h1>X</h1>`),
    );
    if (!("html" in res) || !res.html.extracted) throw new Error("expected an extraction");
    expect(res.html.parts.map((p) => p.sourceOffset)).toEqual([offset]);
  });

  test("a long run of blank lines after an unclosed opener is read in linear time", () => {
    const text = `---${"\n".repeat(256 * 1024)}name\nbolt\n`;
    const started = performance.now();
    extractSource("Clips/h.csv", utf8(text));
    expect(performance.now() - started).toBeLessThan(LINEAR_CEILING_MS);
  });

  test("an unclosed block is data, as the frontmatter reader treats it", () => {
    const res = extractSource("Clips/h.csv", utf8("---\nname\nbolt\n"));
    if (!("table" in res) || !res.table.rendered) throw new Error("expected a rendering");
    expect(res.table.section).toContain("---\nname\nbolt\n");
  });
});

describe("deriveSourceSection names the source's own visibility", () => {
  const vaults: string[] = [];
  afterEach(() => {
    for (const vault of vaults.splice(0)) rmSync(vault, { recursive: true, force: true });
  });

  function derive(rel: string, body: string) {
    const vault = mkdtempSync(join(tmpdir(), "o2b-derive-visibility-"));
    vaults.push(vault);
    mkdirSync(join(vault, "Clips"), { recursive: true });
    writeFileSync(join(vault, rel), body);
    return deriveSourceSection(vault, rel, INTAKE_TRUST.trusted, () => true);
  }

  test("a reserved CSV and a reserved HTML source carry their tokens", () => {
    expect(derive("Clips/h.csv", RESERVED_CSV)?.visibility).toEqual(["private"]);
    expect(derive("Clips/h.html", RESERVED_HTML)?.visibility).toEqual(["private"]);
  });

  test("a byte-order mark before the block hides neither the tokens nor the block", () => {
    const derived = derive("Clips/bom.csv", `\ufeff${RESERVED_CSV}`);
    expect(derived?.visibility).toEqual(["private"]);
    expect(derived?.section).not.toContain("visibility");
  });

  test("a source that grew past the digest ceiling after the intake read answers source-not-local", () => {
    // The intake read the source in the trusted lane and wrote the entity
    // pages; the derived section's own read then meets a file past the
    // ceiling, which must not fail an ingest that already landed.
    const vault = mkdtempSync(join(tmpdir(), "o2b-derive-visibility-"));
    vaults.push(vault);
    mkdirSync(join(vault, "Clips"), { recursive: true });
    writeFileSync(join(vault, "Clips/grown.csv"), "name,qty\nbolt,4\n");
    truncateSync(join(vault, "Clips/grown.csv"), SOURCE_HASH_MAX_BYTES + 1);
    expect(deriveSourceSection(vault, "Clips/grown.csv", INTAKE_TRUST.trusted, () => true)).toEqual(
      {
        format: "csv",
        frontmatter: {},
        section: "",
        table: { rendered: false, format: "csv", reason: "source-not-local" },
      },
    );
  });

  test("a source with no visibility carries none", () => {
    const derived = derive("Clips/parts.csv", "name,qty\nbolt,4\n");
    expect(derived?.table).toMatchObject({ rendered: true });
    expect(derived !== undefined && "visibility" in derived).toBe(false);
  });
});

describe("deriveSourceSection at the caller's reach", () => {
  const bases: string[] = [];
  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  /** A vault holding one CSV source the caller's predicate decides on. */
  function vaultWithCsv(): string {
    const vault = mkdtempSync(join(tmpdir(), "o2b-derive-reach-"));
    bases.push(vault);
    mkdirSync(join(vault, "Clips"), { recursive: true });
    writeFileSync(join(vault, "Clips/parts.csv"), "name,qty\nbolt,4\n");
    return vault;
  }

  // The intake already demotes a hidden source to untrusted, so the ingest
  // tests cannot reach this guard; it is the derived section's own reach
  // contract and must hold even for a caller that hands in `trusted`.
  test("a hidden source is not read even when the lane is trusted", () => {
    const derived = deriveSourceSection(
      vaultWithCsv(),
      "Clips/parts.csv",
      INTAKE_TRUST.trusted,
      () => false,
    );
    expect(derived).toEqual({
      format: "csv",
      frontmatter: {},
      section: "",
      table: { rendered: false, format: "csv", reason: "source-not-local" },
    });
  });

  test("the same source is read when the caller may read it", () => {
    const derived = deriveSourceSection(
      vaultWithCsv(),
      "Clips/parts.csv",
      INTAKE_TRUST.trusted,
      () => true,
    );
    expect(derived?.table).toMatchObject({ rendered: true, rows: 1 });
  });
});
