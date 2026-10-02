/**
 * CSV and TSV table notes (design T1-T6): a pure renderer from source bytes
 * to a fenced plain-text `## Table` section, with the delimiter chosen by
 * extension, RFC 4180 lenient quoting for CSV, the first record as the
 * header, named caps and two redaction passes.
 */

import { describe, expect, test } from "bun:test";

import {
  isTableNoteSkipReason,
  isTableTruncation,
  TABLE_DELIMITER,
  TABLE_NOTE_SKIP_REASON,
  TABLE_NOTE_SKIP_REASONS,
  TABLE_TRUNCATION,
  TABLE_TRUNCATIONS,
  tableNote,
  type TableNoteRendered,
  type TableNoteResult,
  type TableNoteSkipped,
} from "../../../../src/core/brain/ingest/table-note.ts";

const encoder = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

function rendered(result: TableNoteResult): TableNoteRendered {
  if (!result.rendered) {
    throw new Error(`expected a rendered table, got ${result.reason} ${result.detail ?? ""}`);
  }
  return result;
}

function skipped(result: TableNoteResult): TableNoteSkipped {
  if (result.rendered) throw new Error("expected a skipped table");
  return result;
}

/** The lines inside the first `table` fence of a section. */
function fencedLines(section: string): string[] {
  const lines = section.split("\n");
  const open = lines.findIndex((line) => /^`{3,}table$/.test(line));
  const fence = lines[open]!.slice(0, -"table".length);
  const close = lines.indexOf(fence, open + 1);
  return lines.slice(open + 1, close);
}

function csv(text: string, path = "Clips/data.csv"): TableNoteResult {
  return tableNote(path, bytesOf(text));
}

describe("table-note vocabularies", () => {
  test("skip reasons and truncation kinds are closed four-piece unions", () => {
    expect(TABLE_NOTE_SKIP_REASONS).toEqual([
      "source-not-local",
      "not-utf8",
      "contains-nul",
      "malformed-quoting",
      "empty",
    ]);
    expect(TABLE_NOTE_SKIP_REASONS.every(isTableNoteSkipReason)).toBe(true);
    expect(isTableNoteSkipReason("format-unknown")).toBe(false);
    expect(TABLE_TRUNCATIONS).toEqual(["rows", "columns", "cells", "bytes"]);
    expect(TABLE_TRUNCATIONS.every(isTableTruncation)).toBe(true);
    expect(isTableTruncation(42)).toBe(false);
    expect(TABLE_NOTE_SKIP_REASON.malformedQuoting).toBe("malformed-quoting");
    expect(TABLE_TRUNCATION.bytes).toBe("bytes");
    expect(TABLE_DELIMITER).toEqual({ comma: "comma", semicolon: "semicolon", tab: "tab" });
  });

  test("a path that is not csv or tsv is a caller error naming the path", () => {
    expect(() => tableNote("Clips/page.html", bytesOf("a,b"))).toThrow(TypeError);
    expect(() => tableNote("Clips/page.html", bytesOf("a,b"))).toThrow("Clips/page.html");
    expect(() => tableNote("Clips/noext", bytesOf("a,b"))).toThrow(TypeError);
  });
});

describe("CSV parsing", () => {
  test("the pinned shape: header first, cells joined by a spaced bar", () => {
    const result = rendered(csv("name,qty\nbolt,4\nnut,7\n", "Clips/parts.csv"));
    expect(result).toMatchObject({
      format: "csv",
      delimiter: "comma",
      columns: 2,
      rows: 2,
      rowsRendered: 2,
      truncated: [],
      redactedCells: 0,
    });
    expect(result.section).toBe(
      "## Table\n\n### Rows 1-2\n\n```table\nname | qty\nbolt | 4\nnut | 7\n```",
    );
  });

  test("CRLF, LF and a lone CR all end a record; no trailing empty record", () => {
    const expected = ["a | b", "1 | 2", "3 | 4"];
    for (const text of ["a,b\r\n1,2\r\n3,4\r\n", "a,b\n1,2\n3,4", "a,b\r1,2\r3,4\r"]) {
      const result = rendered(csv(text));
      expect(fencedLines(result.section)).toEqual(expected);
      expect(result.rows).toBe(2);
    }
  });

  test("a UTF-8 BOM is stripped and fully empty lines are skipped", () => {
    const result = rendered(csv("﻿id,name\n\n1,x\r\n\r\n2,y\n\n"));
    expect(fencedLines(result.section)).toEqual(["id | name", "1 | x", "2 | y"]);
    expect(result.rows).toBe(2);
  });

  test("quoted fields hold delimiters and line breaks; a doubled quote is one quote", () => {
    const result = rendered(csv('k,v\n"a,b","line1\nline2"\n"say ""hi""",""\n'));
    expect(fencedLines(result.section)).toEqual(["k | v", "a,b | line1\\nline2", 'say "hi" | ']);
  });

  test("bare quotes inside an unquoted field and text after a closing quote are kept", () => {
    const result = rendered(csv('k,v\n5" pipe,"ab"cd\n'));
    expect(fencedLines(result.section)).toEqual(["k | v", '5" pipe | abcd']);
  });

  test("an unterminated quoted field is refused by name with its 1-based record number", () => {
    const result = skipped(csv('h1,h2\n\nok,1\n"open,2\nmore,3\n'));
    expect(result).toEqual({
      rendered: false,
      format: "csv",
      reason: "malformed-quoting",
      detail: "3",
    });
  });

  test("ragged rows keep their own cell count; columns is the widest record", () => {
    const result = rendered(csv("a,b\n1\n1,2,3\n"));
    expect(fencedLines(result.section)).toEqual(["a | b", "1", "1 | 2 | 3"]);
    expect(result.columns).toBe(3);
  });

  test("a semicolon export is read with semicolons only when commas give one field", () => {
    const semicolon = rendered(csv("name;price\nbolt;1,5\nnut;0,25\n"));
    expect(semicolon.delimiter).toBe("semicolon");
    expect(fencedLines(semicolon.section)).toEqual(["name | price", "bolt | 1,5", "nut | 0,25"]);

    const comma = rendered(csv("a;b,c\n1;2,3\n"));
    expect(comma.delimiter).toBe("comma");
    expect(fencedLines(comma.section)).toEqual(["a;b | c", "1;2 | 3"]);

    const single = rendered(csv("only\nx\n"));
    expect(single.delimiter).toBe("comma");
  });

  test("the first record is the header even when it looks like data", () => {
    const result = rendered(csv("1,2\n3,4\n"));
    expect(result.rows).toBe(1);
    expect(fencedLines(result.section)).toEqual(["1 | 2", "3 | 4"]);
  });

  test("the extension decides case-insensitively", () => {
    expect(rendered(tableNote("Clips/DATA.CSV", bytesOf("a,b\n1,2"))).format).toBe("csv");
  });
});

describe("TSV parsing", () => {
  test("TAB-delimited with quotes kept as literal text", () => {
    const result = rendered(tableNote("Clips/data.tsv", bytesOf('k\tv\n"x"\t"a,b"\r\n')));
    expect(result.format).toBe("tsv");
    expect(result.delimiter).toBe("tab");
    expect(fencedLines(result.section)).toEqual(["k | v", '"x" | "a,b"']);
  });

  test("an unbalanced quote in a TSV is data, not a refusal", () => {
    const result = rendered(tableNote("Clips/data.tsv", bytesOf('k\tv\n"open\t1\n')));
    expect(fencedLines(result.section)).toEqual(["k | v", '"open | 1']);
  });
});

describe("refusals", () => {
  test("a NUL byte is refused as contains-nul", () => {
    expect(skipped(csv("a,b\n1,\u00002\n"))).toEqual({
      rendered: false,
      format: "csv",
      reason: "contains-nul",
    });
  });

  test("invalid UTF-8 is refused as not-utf8", () => {
    const bytes = new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x2c, 0x31]);
    expect(skipped(tableNote("Clips/data.tsv", bytes))).toEqual({
      rendered: false,
      format: "tsv",
      reason: "not-utf8",
    });
  });

  test("no records, or a header with no data records, is empty", () => {
    for (const text of ["", "﻿", "\n\r\n\n", "only,header\n"]) {
      expect(skipped(csv(text)).reason).toBe("empty");
    }
  });
});
