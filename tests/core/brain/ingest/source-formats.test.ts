/**
 * The source format registry: one table decides what a file is and whether
 * ingest can read it. The planner's default extension set, its per-file
 * format skips and the extraction dispatch all derive from it, so its order
 * and its extension map are pinned here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_INGESTIBLE_EXTENSIONS,
  isSourceExtractSkipReason,
  isSourceFormat,
  SOURCE_EXTRACT_SKIP_REASON,
  SOURCE_EXTRACT_SKIP_REASONS,
  SOURCE_EXTRACTOR,
  SOURCE_FORMAT,
  SOURCE_FORMAT_BY_EXTENSION,
  SOURCE_FORMAT_SPECS,
  SOURCE_FORMATS,
  sourceFormatOf,
  sourceFormatSpec,
} from "../../../../src/core/brain/ingest/source-formats.ts";

const MODULE_PATH = join(import.meta.dir, "../../../../src/core/brain/ingest/source-formats.ts");

describe("SOURCE_FORMAT_SPECS", () => {
  test("names every format once, in vocabulary order, with its extractor", () => {
    expect(SOURCE_FORMAT_SPECS.map((s) => [s.format, s.extractor])).toEqual([
      ["text", "verbatim"],
      ["csv", "table"],
      ["tsv", "table"],
      ["html", "html"],
      ["pdf", null],
      ["docx", null],
      ["xlsx", null],
      ["pptx", null],
      ["odt", null],
      ["ods", null],
      ["odp", null],
      ["epub", null],
      ["rtf", null],
      ["image", null],
    ]);
    expect(SOURCE_FORMAT_SPECS.map((s) => s.format)).toEqual([...SOURCE_FORMATS]);
  });

  test("maps every registered extension to its format", () => {
    expect(Object.fromEntries(SOURCE_FORMAT_BY_EXTENSION)).toEqual({
      ".md": "text",
      ".markdown": "text",
      ".txt": "text",
      ".text": "text",
      ".rst": "text",
      ".org": "text",
      ".csv": "csv",
      ".tsv": "tsv",
      ".html": "html",
      ".htm": "html",
      ".pdf": "pdf",
      ".docx": "docx",
      ".xlsx": "xlsx",
      ".pptx": "pptx",
      ".odt": "odt",
      ".ods": "ods",
      ".odp": "odp",
      ".epub": "epub",
      ".rtf": "rtf",
      ".png": "image",
      ".jpg": "image",
      ".jpeg": "image",
      ".gif": "image",
      ".webp": "image",
      ".bmp": "image",
      ".tif": "image",
      ".tiff": "image",
      ".heic": "image",
    });
  });

  test("sourceFormatSpec returns the registry row of a format", () => {
    expect(sourceFormatSpec(SOURCE_FORMAT.html).extensions).toEqual([".html", ".htm"]);
    expect(sourceFormatSpec(SOURCE_FORMAT.pdf).extractor).toBeNull();
    expect(sourceFormatSpec(SOURCE_FORMAT.csv).extractor).toBe(SOURCE_EXTRACTOR.table);
  });
});

describe("sourceFormatOf", () => {
  test("reads the lowercased extension of the last path segment", () => {
    expect(sourceFormatOf("Clips/page.html")).toBe("html");
    expect(sourceFormatOf("Clips/PAGE.HTM")).toBe("html");
    expect(sourceFormatOf("data/Parts.CSV")).toBe("csv");
    expect(sourceFormatOf("notes.md")).toBe("text");
    expect(sourceFormatOf("scan.JPEG")).toBe("image");
    expect(sourceFormatOf("Clips\\report.pdf")).toBe("pdf");
    expect(sourceFormatOf("archive.tar.gz")).toBeNull();
    expect(sourceFormatOf("blob.bin")).toBeNull();
  });

  test("an extensionless path, a dotfile, a trailing dot and a directory-like name give null", () => {
    expect(sourceFormatOf("README")).toBeNull();
    expect(sourceFormatOf("dir.csv/README")).toBeNull();
    expect(sourceFormatOf(".csv")).toBeNull();
    expect(sourceFormatOf("Clips/.html")).toBeNull();
    expect(sourceFormatOf("name.")).toBeNull();
    expect(sourceFormatOf("")).toBeNull();
  });

  test("a URL whose last segment carries no registered extension gives null", () => {
    expect(sourceFormatOf("https://example.com")).toBeNull();
    expect(sourceFormatOf("https://example.com/docs/")).toBeNull();
    expect(sourceFormatOf("https://example.com/export?format=csv")).toBeNull();
  });
});

describe("DEFAULT_INGESTIBLE_EXTENSIONS", () => {
  test("is every extension with an extractor, text first, in spec order, and frozen", () => {
    expect([...DEFAULT_INGESTIBLE_EXTENSIONS]).toEqual([
      ".md",
      ".markdown",
      ".txt",
      ".text",
      ".rst",
      ".org",
      ".csv",
      ".tsv",
      ".html",
      ".htm",
    ]);
    expect(Object.isFrozen(DEFAULT_INGESTIBLE_EXTENSIONS)).toBe(true);
  });
});

describe("closed vocabularies", () => {
  test("isSourceFormat accepts only members", () => {
    for (const format of SOURCE_FORMATS) expect(isSourceFormat(format)).toBe(true);
    expect(isSourceFormat("markdown")).toBe(false);
    expect(isSourceFormat("")).toBe(false);
    expect(isSourceFormat(null)).toBe(false);
  });

  test("the extract skip reasons are the pinned tokens", () => {
    expect([...SOURCE_EXTRACT_SKIP_REASONS]).toEqual([
      "format-read-verbatim",
      "format-not-extractable",
      "format-unknown",
      "source-not-local",
      "source-too-large",
      "not-a-regular-file",
      "not-utf8",
    ]);
    expect(isSourceExtractSkipReason(SOURCE_EXTRACT_SKIP_REASON.notUtf8)).toBe(true);
    expect(isSourceExtractSkipReason("unsupported")).toBe(false);
    expect(isSourceExtractSkipReason(7)).toBe(false);
  });
});

describe("Node safety", () => {
  test("the module references no Bun runtime API", () => {
    const text = readFileSync(MODULE_PATH, "utf8");
    expect(text).not.toContain("Bun.");
    expect(text).not.toMatch(/from "bun"/);
  });
});
