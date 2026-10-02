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
 * first record has two or more fields with semicolons and more with
 * semicolons than with commas (the spreadsheet export whose decimal
 * separator is a comma). The first
 * record is always the header: a file on disk carries no `header=` MIME
 * parameter, and any heuristic guesses wrong on all-text tables.
 */

import { fenceFor } from "../../markdown-fence.ts";
import {
  isSecretKeyName,
  REDACTION_PLACEHOLDER,
  redactRawOutput,
  stripPrivateRegions,
} from "../../redactor.ts";
import { countChunkTokens } from "../../search/chunker.ts";
import type { FrontmatterMap } from "../../types.ts";
import { SOURCE_FORMAT, sourceFormatOf } from "./source-formats.ts";

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

/**
 * Cell characters escaped so one record stays one line, a cell boundary
 * stays unambiguous, no rendered line opens with a backtick run (the
 * chunker closes a fence on any line that starts with three backticks,
 * whatever the opening fence's length) and no control character reaches a
 * page or a terminal. Line breaks and TAB keep their short form; every
 * other C0 control, DEL and C1 control becomes `\u{XXXX}`. Reversible:
 * `\` is escaped too.
 */
const CELL_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "\\": "\\\\",
  "|": "\\|",
  "`": "\\`",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
});
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CELL_ESCAPE_RE = /[\\|`\u0000-\u001f\u007f-\u009f]/g;
const CODE_POINT_HEX_DIGITS = 4;

/** `\u{XXXX}`: a control character by its code point. */
function codePointEscape(ch: string): string {
  const hex = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(CODE_POINT_HEX_DIGITS, "0");
  return `\\u{${hex}}`;
}

/** Marks a cell cut at {@link TABLE_NOTE_MAX_CELL_CHARS}. */
const CUT_MARKER = "\u2026";

/**
 * Code units of a cell the value pass reads at most. A cell is cut to
 * {@link TABLE_NOTE_MAX_CELL_CHARS} anyway, so the window only has to be
 * wide enough that a credential the cap would split is still seen whole;
 * bounding it keeps one megabyte-sized cell from costing seconds.
 */
const CELL_SCAN_MAX_CHARS = 4_096;

/**
 * The value pass over a cell window: key=value credentials, private
 * regions and URL userinfo, never truncated by the redactor itself (the
 * window bounds the input and the cell cap applies after the pass).
 */
const CELL_REDACTION = Object.freeze({
  redactUrlCredentials: true,
  maxInput: Number.POSITIVE_INFINITY,
});

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

function utf8Length(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}

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

/**
 * The CSV delimiter: a comma, unless the first record has two or more
 * fields with semicolons and more with semicolons than with commas. A
 * semicolon export quotes only fields holding a semicolon, so its header
 * may carry a bare comma (`Name;Price, EUR;Qty`).
 */
function csvDelimiter(text: string): TableDelimiter {
  const first = (delimiter: TableDelimiter): number => {
    const parsed = parseRecords(text, DELIMITER_CHAR[delimiter], true, 1);
    return parsed.ok ? (parsed.records[0]?.length ?? 0) : 0;
  };
  const comma = first(TABLE_DELIMITER.comma);
  const semicolon = first(TABLE_DELIMITER.semicolon);
  if (semicolon >= 2 && semicolon > comma) return TABLE_DELIMITER.semicolon;
  return TABLE_DELIMITER.comma;
}

/** A cell cut to {@link TABLE_NOTE_MAX_CELL_CHARS} code points, the last one the marker. */
function capCell(cell: string): { readonly text: string; readonly cut: boolean } {
  // A UTF-16 length within the cap is a code-point count within it.
  if (cell.length <= TABLE_NOTE_MAX_CELL_CHARS) return { text: cell, cut: false };
  const points = Array.from(cell);
  if (points.length <= TABLE_NOTE_MAX_CELL_CHARS) return { text: cell, cut: false };
  return { text: points.slice(0, TABLE_NOTE_MAX_CELL_CHARS - 1).join("") + CUT_MARKER, cut: true };
}

function escapeCell(cell: string): string {
  return cell.replace(CELL_ESCAPE_RE, (ch) => CELL_ESCAPES[ch] ?? codePointEscape(ch));
}

/** One record as it is rendered: its line and what the caps and redaction did to it. */
interface PreparedLine {
  readonly line: string;
  readonly width: number;
  readonly redacted: number;
  readonly columnsCut: boolean;
  readonly cellsCut: boolean;
  /** Chunker tokens of {@link line}. */
  readonly tokens: number;
}

/**
 * Cut, redact, cap and escape one record. Only the first
 * {@link CELL_SCAN_MAX_CHARS} code units of a cell are read, and a cell
 * longer than that counts as cut. A cell under a column whose
 * header names a credential is replaced whole (the header is kept: names
 * only); every other cell, header cells included (the first record may be
 * data), goes through the value pass. No bare-token pass: it would erase
 * order ids, SKUs and hashes, which are table data.
 */
function prepareLine(
  record: ReadonlyArray<string>,
  credentialColumns: ReadonlyArray<boolean>,
): PreparedLine {
  const kept = record.slice(0, TABLE_NOTE_MAX_COLUMNS);
  let redacted = 0;
  let cellsCut = false;
  const cells = kept.map((raw, column) => {
    const windowCut = raw.length > CELL_SCAN_MAX_CHARS;
    const window = windowCut ? raw.slice(0, CELL_SCAN_MAX_CHARS) : raw;
    const clean =
      credentialColumns[column] === true && raw.length > 0
        ? REDACTION_PLACEHOLDER
        : redactRawOutput(window, CELL_REDACTION);
    if (clean !== window) redacted += 1;
    const capped = capCell(clean);
    if (capped.cut || windowCut) cellsCut = true;
    return escapeCell(capped.text);
  });
  const line = cells.join(CELL_SEPARATOR);
  return {
    line,
    width: kept.length,
    redacted,
    columnsCut: record.length > kept.length,
    cellsCut,
    tokens: countChunkTokens(line),
  };
}

function groupHeading(first: number, last: number): string {
  return `${GROUP_HEADING_PREFIX}${first}-${last}`;
}

function renderGroup(header: string, lines: ReadonlyArray<string>, first: number): string {
  const body = [header, ...lines].join(NEWLINE);
  const fence = fenceFor(body);
  const heading = groupHeading(first, first + lines.length - 1);
  return `${heading}${BLOCK_SEPARATOR}${fence}${FENCE_INFO}${NEWLINE}${body}${NEWLINE}${fence}`;
}

function closingLine(rendered: number, total: number): string {
  return `Rendered ${rendered} of ${total} rows.`;
}

/** Data rows split into groups of at most {@link TABLE_NOTE_ROWS_PER_GROUP} rows and {@link TABLE_NOTE_GROUP_MAX_TOKENS} tokens. */
function groupRows(
  header: PreparedLine,
  rows: ReadonlyArray<PreparedLine>,
): ReadonlyArray<ReadonlyArray<PreparedLine>> {
  // Tokens are whitespace-delimited, so a group's count is the sum of its
  // lines plus the fixed lines around them (heading, fences, header).
  const overhead = countChunkTokens(renderGroup(header.line, [], 1));
  const groups: PreparedLine[][] = [];
  let current: PreparedLine[] = [];
  let tokens = overhead;
  for (const row of rows) {
    const full =
      current.length === TABLE_NOTE_ROWS_PER_GROUP ||
      (current.length > 0 && tokens + row.tokens > TABLE_NOTE_GROUP_MAX_TOKENS);
    if (full) {
      groups.push(current);
      current = [];
      tokens = overhead;
    }
    current.push(row);
    tokens += row.tokens;
  }
  if (current.length > 0) groups.push(current);
  return groups;
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
  // A private region follows the vault-wide rule before any parsing, so a
  // region that spans records hides every row between its tags, not only
  // the cells that hold a tag.
  text = stripPrivateRegions(text);

  const delimiter = format === SOURCE_FORMAT.tsv ? TABLE_DELIMITER.tab : csvDelimiter(text);
  const parsed = parseRecords(text, DELIMITER_CHAR[delimiter], format === SOURCE_FORMAT.csv);
  if (!parsed.ok) return skip(TABLE_NOTE_SKIP_REASON.malformedQuoting, String(parsed.record));
  const [headerRecord, ...dataRecords] = parsed.records;
  if (headerRecord === undefined || dataRecords.length === 0) {
    return skip(TABLE_NOTE_SKIP_REASON.empty);
  }

  const credentialColumns = headerRecord.map((name) => isSecretKeyName(name));
  const header = prepareLine(headerRecord, []);
  const rows = dataRecords
    .slice(0, TABLE_NOTE_MAX_ROWS)
    .map((record) => prepareLine(record, credentialColumns));

  // Groups are added while the section, with room for the closing line,
  // stays within the byte cap; the last group needs no closing line when
  // nothing else was cut.
  const total = dataRecords.length;
  const reserve = utf8Length(BLOCK_SEPARATOR + closingLine(total, total));
  const groups = groupRows(header, rows);
  const blocks: string[] = [TABLE_HEADING];
  let bytesUsed = utf8Length(TABLE_HEADING);
  let rowsRendered = 0;
  let redactedCells = header.redacted;
  let columns = header.width;
  let columnsCut = header.columnsCut;
  let cellsCut = header.cellsCut;
  let bytesCut = false;
  for (const [index, group] of groups.entries()) {
    const block = renderGroup(
      header.line,
      group.map((row) => row.line),
      rowsRendered + 1,
    );
    const size = utf8Length(BLOCK_SEPARATOR + block);
    const completes = index === groups.length - 1 && rows.length === total;
    if (bytesUsed + size + (completes ? 0 : reserve) > TABLE_NOTE_MAX_BYTES) {
      bytesCut = true;
      break;
    }
    blocks.push(block);
    bytesUsed += size;
    rowsRendered += group.length;
    for (const row of group) {
      redactedCells += row.redacted;
      columns = Math.max(columns, row.width);
      columnsCut ||= row.columnsCut;
      cellsCut ||= row.cellsCut;
    }
  }
  if (rowsRendered < total) blocks.push(closingLine(rowsRendered, total));

  const cuts: Readonly<Record<TableTruncation, boolean>> = {
    rows: total > rows.length,
    columns: columnsCut,
    cells: cellsCut,
    bytes: bytesCut,
  };
  return {
    rendered: true,
    format,
    delimiter,
    columns,
    rows: total,
    rowsRendered,
    truncated: TABLE_TRUNCATIONS.filter((kind) => cuts[kind]),
    redactedCells,
    section: blocks.join(BLOCK_SEPARATOR),
  };
}

/**
 * The frontmatter keys a rendered table adds to its summary page, in the
 * pinned order; `table_truncated` only when a cap cut the rendering.
 */
export function tableNoteFrontmatter(result: TableNoteRendered): FrontmatterMap {
  const keys: FrontmatterMap = {
    table_delimiter: result.delimiter,
    table_columns: result.columns,
    table_rows: result.rows,
    table_rows_rendered: result.rowsRendered,
  };
  if (result.truncated.length > 0) keys.table_truncated = [...result.truncated];
  return keys;
}
