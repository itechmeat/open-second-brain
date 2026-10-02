/**
 * CSV and TSV table notes: source bytes in, a fenced plain-text `## Table`
 * section out. Pure, no I/O: the caller decides whether the bytes may be
 * read at all (the reach order lives in `extract-source.ts`).
 *
 * The section is fenced plain text, not a GFM table: inside a fence a
 * `[[x]]` or `#word` cell stays out of the link graph, and the chunker
 * never splits a table it does not recognise as one. Each row group sits
 * under its own `### Rows a-b` heading and repeats the header record, so
 * every chunk carries both the column names and a heading path.
 *
 * Parsing follows the delimiter the extension names: `.tsv` is TAB with no
 * quote processing (fields cannot hold a TAB or a line break); `.csv` is a
 * comma with lenient RFC 4180 quoting, read with semicolons only when the
 * first record is one field with commas and two or more with semicolons
 * (the spreadsheet export whose decimal separator is a comma). The first
 * record is always the header: a file on disk carries no `header=` MIME
 * parameter, and any heuristic guesses wrong on all-text tables.
 */

import { SOURCE_FORMAT, sourceFormatOf } from "./source-formats.ts";
import { fenceFor } from "../../markdown-fence.ts";

/** Data rows rendered at most; the rest are counted, not shown. */
export const TABLE_NOTE_MAX_ROWS = 1_000;
/** Columns rendered at most; wider records are cut at the right. */
export const TABLE_NOTE_MAX_COLUMNS = 64;
/** Code points kept per cell; a longer cell is cut and marked. */
export const TABLE_NOTE_MAX_CELL_CHARS = 256;
/** UTF-8 bytes of the rendered section at most; rows stop at the last whole group that fits. */
export const TABLE_NOTE_MAX_BYTES = 262_144;
/** Data rows per group at most. */
export const TABLE_NOTE_ROWS_PER_GROUP = 50;
/** Chunker tokens per group block at most, so one group fits one chunk. */
export const TABLE_NOTE_GROUP_MAX_TOKENS = 600;

/** The delimiter a table was read with, recorded on the page as a word. */
export const TABLE_DELIMITER = Object.freeze({
  comma: "comma",
  semicolon: "semicolon",
  tab: "tab",
} as const);

export type TableDelimiter = (typeof TABLE_DELIMITER)[keyof typeof TABLE_DELIMITER];

/** Which cap cut the rendering. Closed four-piece vocabulary (census row `TABLE_TRUNCATION`). */
export const TABLE_TRUNCATION = Object.freeze({
  /** More data rows than {@link TABLE_NOTE_MAX_ROWS}. */
  rows: "rows",
  /** A record wider than {@link TABLE_NOTE_MAX_COLUMNS}. */
  columns: "columns",
  /** A cell longer than {@link TABLE_NOTE_MAX_CELL_CHARS}. */
  cells: "cells",
  /** Row groups dropped to keep the section within {@link TABLE_NOTE_MAX_BYTES}. */
  bytes: "bytes",
} as const);

export type TableTruncation = (typeof TABLE_TRUNCATION)[keyof typeof TABLE_TRUNCATION];

/** Membership list, in the order the caps are applied. */
export const TABLE_TRUNCATIONS: ReadonlyArray<TableTruncation> = Object.freeze(
  Object.values(TABLE_TRUNCATION),
);

export function isTableTruncation(value: unknown): value is TableTruncation {
  return typeof value === "string" && (TABLE_TRUNCATIONS as ReadonlyArray<string>).includes(value);
}

/**
 * Why no table was rendered. Closed four-piece vocabulary (census row
 * `TABLE_NOTE_SKIP_REASON`). Data, not an error: the summary page and its
 * entities are written either way.
 */
export const TABLE_NOTE_SKIP_REASON = Object.freeze({
  /** A URL, an absent file or a file hidden at the caller's reach: one token for all three. */
  sourceNotLocal: "source-not-local",
  /** The bytes are not strict UTF-8. */
  notUtf8: "not-utf8",
  /** The text holds a NUL character (a binary or UTF-16 file). */
  containsNul: "contains-nul",
  /** A quoted field is still open at the end of the input; `detail` is its 1-based record number. */
  malformedQuoting: "malformed-quoting",
  /** No data record after the header. */
  empty: "empty",
} as const);

export type TableNoteSkipReason =
  (typeof TABLE_NOTE_SKIP_REASON)[keyof typeof TABLE_NOTE_SKIP_REASON];

/** Membership list, in the order a source meets the checks. */
export const TABLE_NOTE_SKIP_REASONS: ReadonlyArray<TableNoteSkipReason> = Object.freeze(
  Object.values(TABLE_NOTE_SKIP_REASON),
);

export function isTableNoteSkipReason(value: unknown): value is TableNoteSkipReason {
  return (
    typeof value === "string" && (TABLE_NOTE_SKIP_REASONS as ReadonlyArray<string>).includes(value)
  );
}

export type TableFormat = typeof SOURCE_FORMAT.csv | typeof SOURCE_FORMAT.tsv;

export interface TableNoteRendered {
  readonly rendered: true;
  readonly format: TableFormat;
  readonly delimiter: TableDelimiter;
  /** Rendered column count: the widest rendered record, capped. */
  readonly columns: number;
  /** Data records in the source, header excluded. */
  readonly rows: number;
  readonly rowsRendered: number;
  /** Every cap that cut the rendering, in {@link TABLE_TRUNCATIONS} order; empty when none. */
  readonly truncated: ReadonlyArray<TableTruncation>;
  readonly redactedCells: number;
  readonly section: string;
}

export interface TableNoteSkipped {
  readonly rendered: false;
  readonly format: TableFormat;
  readonly reason: TableNoteSkipReason;
  readonly detail?: string;
}

export type TableNoteResult = TableNoteRendered | TableNoteSkipped;

const TABLE_HEADING = "## Table";
const GROUP_HEADING_PREFIX = "### Rows ";
const FENCE_INFO = "table";
const CELL_SEPARATOR = " | ";
const NEWLINE = "\n";
const BLOCK_SEPARATOR = "\n\n";

const QUOTE = '"';
const CR = "\r";
const LF = "\n";
const NUL = "\u0000";

const DELIMITER_CHAR: Readonly<Record<TableDelimiter, string>> = Object.freeze({
  comma: ",",
  semicolon: ";",
  tab: "\t",
});

/** Cell characters escaped so one record stays one line and a cell boundary stays unambiguous. */
const CELL_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "\\": "\\\\",
  "|": "\\|",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
});
const CELL_ESCAPE_RE = /[\\|\n\r\t]/g;

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

type Records = string[][];
type ParseOutcome =
  | { readonly ok: true; readonly records: Records }
  | { readonly ok: false; readonly record: number };

/**
 * Split `text` into records. Records end at CRLF, LF or a lone CR outside
 * quotes; a fully empty line is skipped; a final line break makes no empty
 * record. With `quoting`, a field that opens with `"` is quoted (`""` is a
 * literal quote, delimiters and line breaks are literal), text after the
 * closing quote is appended literally, and a bare `"` elsewhere is kept.
 * Stops after `maxRecords` records. Linear in the input.
 */
function parseRecords(
  text: string,
  delimiter: string,
  quoting: boolean,
  maxRecords = Number.POSITIVE_INFINITY,
): ParseOutcome {
  const records: Records = [];
  let record: string[] = [];
  let field = "";
  let recordStarted = false;
  let fieldStarted = false;
  let inQuotes = false;
  let i = 0;
  const endRecord = (): void => {
    record.push(field);
    records.push(record);
    record = [];
    field = "";
    recordStarted = false;
    fieldStarted = false;
  };
  while (i < text.length && records.length < maxRecords) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === QUOTE) {
        if (text[i + 1] === QUOTE) {
          field += QUOTE;
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === CR || ch === LF) {
      i += ch === CR && text[i + 1] === LF ? 2 : 1;
      if (recordStarted) endRecord();
      continue;
    }
    recordStarted = true;
    if (ch === delimiter) {
      record.push(field);
      field = "";
      fieldStarted = false;
    } else if (quoting && ch === QUOTE && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else {
      field += ch;
      fieldStarted = true;
    }
    i += 1;
  }
  if (inQuotes) return { ok: false, record: records.length + 1 };
  if (recordStarted && records.length < maxRecords) endRecord();
  return { ok: true, records };
}

/** The CSV delimiter: a comma, unless the first record is one field with commas and more with semicolons. */
function csvDelimiter(text: string): TableDelimiter {
  const first = (delimiter: TableDelimiter): number => {
    const parsed = parseRecords(text, DELIMITER_CHAR[delimiter], true, 1);
    return parsed.ok ? (parsed.records[0]?.length ?? 0) : 0;
  };
  if (first(TABLE_DELIMITER.comma) === 1 && first(TABLE_DELIMITER.semicolon) >= 2) {
    return TABLE_DELIMITER.semicolon;
  }
  return TABLE_DELIMITER.comma;
}

function escapeCell(cell: string): string {
  return cell.replace(CELL_ESCAPE_RE, (ch) => CELL_ESCAPES[ch]!);
}

function renderLine(record: ReadonlyArray<string>): string {
  return record.map(escapeCell).join(CELL_SEPARATOR);
}

function renderGroup(header: string, lines: ReadonlyArray<string>, first: number): string {
  const body = [header, ...lines].join(NEWLINE);
  const fence = fenceFor(body);
  const heading = `${GROUP_HEADING_PREFIX}${first}-${first + lines.length - 1}`;
  return `${heading}${BLOCK_SEPARATOR}${fence}${FENCE_INFO}${NEWLINE}${body}${NEWLINE}${fence}`;
}

function tableFormatOf(path: string): TableFormat {
  const format = sourceFormatOf(path);
  if (format === SOURCE_FORMAT.csv || format === SOURCE_FORMAT.tsv) return format;
  throw new TypeError(`not a table source (csv or tsv): ${path}`);
}

/**
 * Render the table note of the CSV or TSV file at `path` from its bytes.
 * Throws `TypeError` naming `path` when its extension is not a table
 * format: that is a caller error, not a property of the bytes.
 */
export function tableNote(path: string, bytes: Uint8Array): TableNoteResult {
  const format = tableFormatOf(path);
  const skip = (reason: TableNoteSkipReason, detail?: string): TableNoteSkipped =>
    detail === undefined
      ? { rendered: false, format, reason }
      : { rendered: false, format, reason, detail };

  let text: string;
  try {
    text = UTF8_STRICT.decode(bytes);
  } catch {
    return skip(TABLE_NOTE_SKIP_REASON.notUtf8);
  }
  if (text.includes(NUL)) return skip(TABLE_NOTE_SKIP_REASON.containsNul);

  const delimiter = format === SOURCE_FORMAT.tsv ? TABLE_DELIMITER.tab : csvDelimiter(text);
  const parsed = parseRecords(text, DELIMITER_CHAR[delimiter], format === SOURCE_FORMAT.csv);
  if (!parsed.ok) return skip(TABLE_NOTE_SKIP_REASON.malformedQuoting, String(parsed.record));
  const [headerRecord, ...dataRecords] = parsed.records;
  if (headerRecord === undefined || dataRecords.length === 0) {
    return skip(TABLE_NOTE_SKIP_REASON.empty);
  }

  const header = renderLine(headerRecord);
  const groups: string[] = [];
  for (let start = 0; start < dataRecords.length; start += TABLE_NOTE_ROWS_PER_GROUP) {
    const slice = dataRecords.slice(start, start + TABLE_NOTE_ROWS_PER_GROUP);
    groups.push(renderGroup(header, slice.map(renderLine), start + 1));
  }
  const columns = Math.max(...parsed.records.map((r) => r.length));
  return {
    rendered: true,
    format,
    delimiter,
    columns,
    rows: dataRecords.length,
    rowsRendered: dataRecords.length,
    truncated: [],
    redactedCells: 0,
    section: [TABLE_HEADING, ...groups].join(BLOCK_SEPARATOR),
  };
}
