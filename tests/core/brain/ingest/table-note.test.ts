/**
 * CSV and TSV table notes (design T1-T6): a pure renderer from source bytes
 * to a fenced plain-text `## Table` section, with the delimiter chosen by
 * extension, RFC 4180 lenient quoting for CSV, the first record as the
 * header, named caps and two redaction passes.
 */

import { describe, expect, test } from "bun:test";

import { fakeCredential } from "../../../helpers/fake-credentials.ts";

import {
  PRIVATE_REGION_PLACEHOLDER,
  REDACTION_PLACEHOLDER,
} from "../../../../src/core/redactor.ts";
import { countChunkTokens } from "../../../../src/core/search/chunker.ts";
import {
  isTableNoteSkipReason,
  isTableTruncation,
  TABLE_DELIMITER,
  TABLE_NOTE_GROUP_MAX_TOKENS,
  TABLE_NOTE_MAX_BYTES,
  TABLE_NOTE_MAX_CELL_CHARS,
  TABLE_NOTE_MAX_COLUMNS,
  TABLE_NOTE_MAX_ROWS,
  TABLE_NOTE_ROWS_PER_GROUP,
  TABLE_NOTE_SKIP_REASON,
  TABLE_NOTE_SKIP_REASONS,
  TABLE_TRUNCATION,
  TABLE_TRUNCATIONS,
  tableNote,
  tableNoteFrontmatter,
  type TableNoteRendered,
  type TableNoteResult,
  type TableNoteSkipped,
} from "../../../../src/core/brain/ingest/table-note.ts";

const encoder = new TextEncoder();

/** A cell pass bounded by a window takes milliseconds; a whole-cell pass over megabytes takes seconds. */
const CELL_PASS_CEILING_MS = 1_000;
const MIB = 1 << 20;

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

  test("a semicolon export is read with semicolons; semicolons in comma cells are data", () => {
    const semicolon = rendered(csv("name;price\nbolt;1,5\nnut;0,25\n"));
    expect(semicolon.delimiter).toBe("semicolon");
    expect(fencedLines(semicolon.section)).toEqual(["name | price", "bolt | 1,5", "nut | 0,25"]);

    const comma = rendered(csv("a;b,c\n1;2,3\n"));
    expect(comma.delimiter).toBe("comma");
    expect(fencedLines(comma.section)).toEqual(["a;b | c", "1;2 | 3"]);

    const single = rendered(csv("only\nx\n"));
    expect(single.delimiter).toBe("comma");
  });

  test("a semicolon header with a comma inside a field is still read with semicolons", () => {
    for (const text of ['name;"price, eur";qty\nAnn;1,5;2\n', "Name;Price, EUR;Qty\nAnn;1,5;2\n"]) {
      const result = rendered(csv(text));
      expect(result.delimiter).toBe("semicolon");
      expect(result.columns).toBe(3);
      expect(fencedLines(result.section)[1]).toBe("Ann | 1,5 | 2");
    }
    const quoted = rendered(csv('"a;b",c\n1,2\n'));
    expect(quoted.delimiter).toBe("comma");
    expect(fencedLines(quoted.section)).toEqual(["a;b | c", "1 | 2"]);
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

/** Every `### Rows a-b` group of a section with its fenced lines. */
function groupsOf(
  section: string,
): Array<{ first: number; last: number; block: string; lines: string[] }> {
  const parts = section.split(/\n\n(?=### Rows )/).slice(1);
  return parts.map((part) => {
    const match = /^### Rows (\d+)-(\d+)\n\n([\s\S]*?)(?:\n\nRendered \d+ of \d+ rows\.)?$/.exec(
      part,
    )!;
    return {
      first: Number(match[1]),
      last: Number(match[2]),
      block: `### Rows ${match[1]}-${match[2]}\n\n${match[3]}`,
      lines: fencedLines(match[3]!),
    };
  });
}

function csvOf(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return [header, ...rows].map((r) => r.join(",")).join("\n");
}

function numberedRows(count: number, columns: number, cell: (r: number, c: number) => string) {
  return Array.from({ length: count }, (_row, r) =>
    Array.from({ length: columns }, (_column, c) => cell(r + 1, c + 1)),
  );
}

/** A 240-character cell with no whitespace: many bytes, one token. */
function wideCell(r: number, c: number): string {
  return `${r}-${c}-${"w".repeat(240)}`;
}

/** A five-word cell. */
function wordsCell(r: number, c: number): string {
  return `row ${r} cell ${c} text`;
}

describe("caps", () => {
  test("more rows than the cap: the rest are counted, named and stated on a closing line", () => {
    const header = ["id", "v"];
    const result = rendered(
      csv(
        csvOf(
          header,
          numberedRows(TABLE_NOTE_MAX_ROWS + 1, 2, (r) => `${r}`),
        ),
      ),
    );
    expect(result.rows).toBe(TABLE_NOTE_MAX_ROWS + 1);
    expect(result.rowsRendered).toBe(TABLE_NOTE_MAX_ROWS);
    expect(result.truncated).toEqual(["rows"]);
    expect(
      result.section.endsWith(
        `\n\nRendered ${TABLE_NOTE_MAX_ROWS} of ${TABLE_NOTE_MAX_ROWS + 1} rows.`,
      ),
    ).toBe(true);
    expect(groupsOf(result.section).at(-1)!.last).toBe(TABLE_NOTE_MAX_ROWS);
  });

  test("a record wider than the cap is cut at the right", () => {
    const width = TABLE_NOTE_MAX_COLUMNS + 6;
    const header = Array.from({ length: width }, (_, c) => `c${c + 1}`);
    const result = rendered(csv(csvOf(header, [header.map((_, c) => `${c + 1}`)])));
    expect(result.columns).toBe(TABLE_NOTE_MAX_COLUMNS);
    expect(result.truncated).toEqual(["columns"]);
    const [head, row] = fencedLines(result.section);
    expect(head!.split(" | ")).toEqual(header.slice(0, TABLE_NOTE_MAX_COLUMNS));
    expect(row!.split(" | ").at(-1)).toBe(String(TABLE_NOTE_MAX_COLUMNS));
    expect(result.section).not.toContain("Rendered ");
  });

  test("a 10,000-column record is cut to the column cap without dropping the row", () => {
    const width = 10_000;
    const header = Array.from({ length: width }, (_, c) => `c${c + 1}`);
    const result = rendered(csv(csvOf(header, [header.map((_, c) => `${c + 1}`)])));
    expect(result.columns).toBe(TABLE_NOTE_MAX_COLUMNS);
    expect(result.rows).toBe(1);
    expect(result.truncated).toEqual(["columns"]);
    const [head, row] = fencedLines(result.section);
    expect(head!.split(" | ")).toHaveLength(TABLE_NOTE_MAX_COLUMNS);
    expect(row!.split(" | ")).toHaveLength(TABLE_NOTE_MAX_COLUMNS);
  });

  test("an unterminated quote that runs to the end of a large file is refused, not rendered", () => {
    const result = skipped(csv(`h\nok\n"${"x,".repeat(50_000)}`));
    expect(result).toEqual({
      rendered: false,
      format: "csv",
      reason: "malformed-quoting",
      detail: "3",
    });
  });

  test("a long cell is cut at a code-point boundary and marked with an ellipsis", () => {
    const long = "\u{1F600}".repeat(TABLE_NOTE_MAX_CELL_CHARS + 10);
    const result = rendered(csv(`k,v\nshort,${long}\n`));
    expect(result.truncated).toEqual(["cells"]);
    const cell = fencedLines(result.section)[1]!.split(" | ")[1]!;
    expect(Array.from(cell)).toHaveLength(TABLE_NOTE_MAX_CELL_CHARS);
    expect(cell).toBe(`${"\u{1F600}".repeat(TABLE_NOTE_MAX_CELL_CHARS - 1)}\u2026`);
    const exact = "x".repeat(TABLE_NOTE_MAX_CELL_CHARS);
    expect(rendered(csv(`k\n${exact}\n`)).truncated).toEqual([]);
  });

  test("a megabyte of nested private tags in a cell is hidden in linear time", () => {
    const nested = `${"<private>".repeat(MIB / 8)}</private>`;
    const started = performance.now();
    const result = rendered(csv(`k,v\nrow,${nested}\n`));
    expect(performance.now() - started).toBeLessThan(CELL_PASS_CEILING_MS);
    expect(fencedLines(result.section)[1]).toBe(`row | ${PRIVATE_REGION_PLACEHOLDER}`);
  });

  test("a megabyte-sized cell is redacted in a bounded window, not scanned whole", () => {
    const userinfo = "a://b:".repeat((4 * MIB) / 6);
    const started = performance.now();
    const result = rendered(csv(`k,v\nrow,${userinfo}\n`));
    expect(performance.now() - started).toBeLessThan(CELL_PASS_CEILING_MS);
    expect(result.truncated).toEqual(["cells"]);
    const value = fencedLines(result.section)[1]!.split(" | ")[1]!;
    expect(Array.from(value)).toHaveLength(TABLE_NOTE_MAX_CELL_CHARS);
  });

  test("a cell past the scan window counts as cut even when its redacted window fits", () => {
    const result = rendered(csv(`k,v\nrow,api_key=${"x".repeat(5_000)} tail\n`));
    expect(fencedLines(result.section)[1]).toBe(`row | api_key=${REDACTION_PLACEHOLDER}`);
    expect(result.truncated).toEqual(["cells"]);
  });

  test("groups that would pass the byte cap are dropped whole and named", () => {
    const result = rendered(csv(csvOf(["a", "b", "c", "d"], numberedRows(900, 4, wideCell))));
    expect(result.truncated).toEqual(["bytes"]);
    expect(new TextEncoder().encode(result.section).length).toBeLessThanOrEqual(
      TABLE_NOTE_MAX_BYTES,
    );
    expect(result.rowsRendered).toBeLessThan(900);
    expect(result.rowsRendered).toBeGreaterThan(0);
    expect(groupsOf(result.section).at(-1)!.last).toBe(result.rowsRendered);
    expect(result.section.endsWith(`Rendered ${result.rowsRendered} of 900 rows.`)).toBe(true);
  });

  test("width and caps count only the rows the byte cap kept", () => {
    const rows = numberedRows(TABLE_NOTE_MAX_ROWS - 1, 3, () => "w".repeat(250));
    rows.push(Array.from({ length: 70 }, (_, c) => `x${c}`));
    const result = rendered(csv(csvOf(["a", "b", "c"], rows)));
    expect(result.rowsRendered).toBeLessThan(TABLE_NOTE_MAX_ROWS);
    expect(result.columns).toBe(3);
    expect(result.truncated).toEqual(["bytes"]);
  });

  test("several caps are named in the vocabulary order", () => {
    const width = TABLE_NOTE_MAX_COLUMNS + 1;
    const header = Array.from({ length: width }, (_, c) => `c${c}`);
    const rows = numberedRows(TABLE_NOTE_MAX_ROWS + 5, width, (r, c) =>
      r === 1 && c === 1 ? "y".repeat(400) : "1",
    );
    const result = rendered(csv(csvOf(header, rows)));
    expect(result.truncated.slice(0, 3)).toEqual(["rows", "columns", "cells"]);
  });
});

describe("row groups", () => {
  test("a narrow table groups at most 50 rows, each group repeating the header", () => {
    const result = rendered(
      csv(
        csvOf(
          ["id", "v"],
          numberedRows(120, 2, (r, c) => `${r}.${c}`),
        ),
      ),
    );
    const groups = groupsOf(result.section);
    expect(groups.map((g) => [g.first, g.last])).toEqual([
      [1, 50],
      [51, 100],
      [101, 120],
    ]);
    for (const group of groups) {
      expect(group.lines[0]).toBe("id | v");
      expect(group.lines).toHaveLength(group.last - group.first + 2);
    }
    expect(groups[1]!.lines[1]).toBe("51.1 | 51.2");
  });

  test("a wide table groups by the token budget as well, below the row cap", () => {
    const header = Array.from({ length: 15 }, (_, c) => `column ${c}`);
    const result = rendered(csv(csvOf(header, numberedRows(200, 15, wordsCell))));
    const groups = groupsOf(result.section);
    expect(groups.length).toBeGreaterThan(200 / TABLE_NOTE_ROWS_PER_GROUP);
    let next = 1;
    for (const group of groups) {
      expect(group.first).toBe(next);
      expect(group.last - group.first + 1).toBeLessThanOrEqual(TABLE_NOTE_ROWS_PER_GROUP);
      expect(countChunkTokens(group.block)).toBeLessThanOrEqual(TABLE_NOTE_GROUP_MAX_TOKENS);
      next = group.last + 1;
    }
    expect(next).toBe(201);
  });

  test("a single row over the token budget forms its own group", () => {
    // Twenty cells of forty words each: more tokens than one group may hold.
    const cell = Array.from({ length: 40 }, () => "ab").join(" ");
    const big = Array.from({ length: 20 }, () => cell).join(",");
    expect(countChunkTokens(big.replaceAll(",", " | "))).toBeGreaterThan(
      TABLE_NOTE_GROUP_MAX_TOKENS,
    );
    const result = rendered(csv(`k,v\na,1\nb,${big}\nc,3\n`));
    expect(groupsOf(result.section).map((g) => [g.first, g.last])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });
});

describe("escapes and fences", () => {
  test("bars, backslashes, tabs and line breaks are escaped inside a cell", () => {
    const result = rendered(csv('k,v\n"a|b","c\\d\te\r\nf"\n'));
    expect(fencedLines(result.section)[1]).toBe("a\\|b | c\\\\d\\te\\r\\nf");
  });

  test("every other C0 control, DEL and C1 control is escaped by code point", () => {
    const result = rendered(
      csv('k,v\nterm,"a\u001b]0;title\u0007b"\nmore,"\u007f\u0085\u009f\u0001"\n'),
    );
    expect(fencedLines(result.section).slice(1)).toEqual([
      "term | a\\u{001B}]0;title\\u{0007}b",
      "more | \\u{007F}\\u{0085}\\u{009F}\\u{0001}",
    ]);
    // oxlint-disable-next-line no-control-regex -- matching control characters is the point
    expect(result.section).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  test("backticks in a cell are escaped, so a table body always takes a three-backtick fence", () => {
    const result = rendered(csv("k,v\n```js,````\ny,a`b\n"));
    expect(result.section).toContain("\n```table\n");
    expect(result.section).not.toContain("````");
    expect(fencedLines(result.section)).toEqual([
      "k | v",
      "\\`\\`\\`js | \\`\\`\\`\\`",
      "y | a\\`b",
    ]);
  });

  test("links and tags in cells stay inside the fence", () => {
    const result = rendered(csv("k,v\n[[Secret Page]],#tag\n"));
    expect(fencedLines(result.section)[1]).toBe("[[Secret Page]] | #tag");
  });
});

describe("redaction", () => {
  test("a key-like header redacts its column; other cells go through the value pass", () => {
    const credential = fakeCredential("q7Lm", "Zp2x", "Vb9n", "Rt4k");
    const userinfo = fakeCredential("https://deploy:", "hunter", "2pass@example.com/repo");
    const text = `name,api_key,url\nalpha,${credential},${userinfo}\nbeta,,plain\n`;
    const result = rendered(csv(text));
    expect(result.redactedCells).toBe(2);
    expect(result.section).not.toContain(credential);
    expect(result.section).not.toContain("hunter2pass");
    const [head, alpha, beta] = fencedLines(result.section);
    expect(head).toBe("name | api_key | url");
    expect(alpha).toBe(
      `alpha | ${REDACTION_PLACEHOLDER} | https://${REDACTION_PLACEHOLDER}@example.com/repo`,
    );
    expect(beta).toBe("beta |  | plain");
  });

  test("a keyword header over-redacts by design: the single key-name predicate decides", () => {
    const result = rendered(csv("keyword,count\napple,3\npear,5\n"));
    expect(result.redactedCells).toBe(2);
    expect(fencedLines(result.section)).toEqual([
      "keyword | count",
      `${REDACTION_PLACEHOLDER} | 3`,
      `${REDACTION_PLACEHOLDER} | 5`,
    ]);
  });

  test("a private region spanning records hides the rows between its tags", () => {
    const text = "name,note\n<private>,x\nbob,ssn 123-45-6789\n</private>,y\ncarol,z\n";
    const result = rendered(csv(text));
    expect(fencedLines(result.section)).toEqual([
      "name | note",
      `${PRIVATE_REGION_PLACEHOLDER} | y`,
      "carol | z",
    ]);
    expect(result.rows).toBe(2);
    expect(result.section).not.toContain("123-45-6789");
    expect(result.section).not.toContain("private>");
    const tsv = rendered(tableNote("Clips/data.tsv", bytesOf(text.replaceAll(",", "\t"))));
    expect(tsv.section).not.toContain("123-45-6789");
  });

  test("order ids and hashes are table data, not tokens", () => {
    const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const result = rendered(csv(`order,digest\nA1B2C3D4E5F6G7H8,${hash}\n`));
    expect(result.redactedCells).toBe(0);
    expect(fencedLines(result.section)[1]).toBe(`A1B2C3D4E5F6G7H8 | ${hash}`);
  });
});

describe("frontmatter", () => {
  test("frontmatter keys in the pinned order; table_truncated only when something was cut", () => {
    const plain = rendered(csv("name,qty\nbolt,4\nnut,7\n"));
    expect(Object.entries(tableNoteFrontmatter(plain))).toEqual([
      ["table_delimiter", "comma"],
      ["table_columns", 2],
      ["table_rows", 2],
      ["table_rows_rendered", 2],
    ]);
    const cut = rendered(
      csv(
        csvOf(
          ["id"],
          numberedRows(TABLE_NOTE_MAX_ROWS + 1, 1, (r) => `${r}`),
        ),
      ),
    );
    expect(tableNoteFrontmatter(cut)).toEqual({
      table_delimiter: "comma",
      table_columns: 1,
      table_rows: TABLE_NOTE_MAX_ROWS + 1,
      table_rows_rendered: TABLE_NOTE_MAX_ROWS,
      table_truncated: ["rows"],
    });
  });
});
