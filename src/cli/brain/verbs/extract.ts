/**
 * `o2b brain extract <file> [--json]`: preview what ingest derives from one
 * source file, for every registered format.
 *
 * An HTML file answers its title, its text and its heading-derived parts; a
 * CSV or TSV file answers its table note (the counts and the rendered
 * section). Every other format - text read as it is, a named format with no
 * extractor, an unknown extension - answers `extracted: false` with the
 * reason by name, without reading the file. So does an HTML or table file
 * the bounded reader refuses (not a regular file, larger than the read
 * limit). "Could not extract" is data: every such answer exits 0. Read-only
 * and deterministic; nothing is written.
 */

import { lstatSync } from "node:fs";

import { oneLine } from "../../../core/brain/architect/manifests.ts";
import {
  formatPartLine,
  HTML_EXTRACT_MAX_SOURCE_BYTES,
  type HtmlPart,
} from "../../../core/brain/ingest/extract-html.ts";
import { extractSource, type SourceExtraction } from "../../../core/brain/ingest/extract-source.ts";
import { readSourceBounded, type SourceUnread } from "../../../core/brain/ingest/ingest.ts";
import {
  SOURCE_EXTRACT_SKIP_REASON,
  SOURCE_EXTRACTOR,
  type SourceExtractor,
  sourceFormatOf,
  sourceFormatSpec,
  type SourceExtractSkipReason,
} from "../../../core/brain/ingest/source-formats.ts";
import { fail, ok, okJson, parse, usageError } from "../helpers.ts";

const USAGE = "usage: o2b brain extract <file> [--json]";
/** The bytes handed to the dispatch for a format answered by name. */
const NO_BYTES = new Uint8Array(0);
/** How the text output names the format of an unregistered extension. */
const UNKNOWN_FORMAT_LABEL = "unknown";

/** The skip reason each bounded-read refusal answers. */
const UNREAD_REASON: Readonly<Record<SourceUnread, SourceExtractSkipReason>> = Object.freeze({
  "not a regular file": SOURCE_EXTRACT_SKIP_REASON.notARegularFile,
  "larger than the read limit": SOURCE_EXTRACT_SKIP_REASON.sourceTooLarge,
});

/** The extractors that read a source's bytes; every other format is answered by name. */
const BYTE_READING_EXTRACTORS: ReadonlySet<SourceExtractor> = new Set([
  SOURCE_EXTRACTOR.html,
  SOURCE_EXTRACTOR.table,
]);

/**
 * The dispatch answer for `file`. The path is lstat-ed first, before any
 * format is named: a missing path and a symbolic link are both errors. A
 * format with no byte-reading extractor (text read as it is, a named format
 * with no extractor, an unknown extension) is then answered by name without
 * reading the file. An HTML or table source goes through the bounded
 * reader, whose refusal answers in the same shape as a format skip.
 */
function extractFile(file: string): SourceExtraction {
  if (lstatSync(file).isSymbolicLink()) throw new Error(`symbolic link: ${file}`);
  const format = sourceFormatOf(file);
  const extractor = format === null ? null : sourceFormatSpec(format).extractor;
  if (extractor === null || !BYTE_READING_EXTRACTORS.has(extractor)) {
    return extractSource(file, NO_BYTES);
  }
  const read = readSourceBounded(file, HTML_EXTRACT_MAX_SOURCE_BYTES);
  if (read.unread !== undefined) {
    return { extractor: null, format, reason: UNREAD_REASON[read.unread] };
  }
  return extractSource(file, read.bytes);
}

/** The wire shape of one HTML part. */
function partJson(part: HtmlPart): Record<string, unknown> {
  return {
    index: part.index,
    level: part.level,
    heading: part.heading,
    trail: part.trail,
    line_start: part.lineStart,
    line_end: part.lineEnd,
    source_offset: part.sourceOffset,
  };
}

/** The `--json` payload (without `ok`) for `path`. */
function extractionJson(path: string, extraction: SourceExtraction): Record<string, unknown> {
  if (extraction.extractor === SOURCE_EXTRACTOR.html) {
    const html = extraction.html;
    if (!html.extracted) {
      return { path, extracted: false, format: extraction.format, reason: html.reason };
    }
    return {
      path,
      extracted: true,
      format: extraction.format,
      title: html.title,
      text: html.text,
      parts: html.parts.map(partJson),
      ...(html.partsOmitted > 0 ? { parts_omitted: html.partsOmitted } : {}),
    };
  }
  if (extraction.extractor === SOURCE_EXTRACTOR.table) {
    const table = extraction.table;
    if (!table.rendered) {
      return {
        path,
        extracted: false,
        format: table.format,
        reason: table.reason,
        ...(table.detail !== undefined ? { detail: table.detail } : {}),
      };
    }
    return {
      path,
      extracted: true,
      format: table.format,
      delimiter: table.delimiter,
      columns: table.columns,
      rows: table.rows,
      rows_rendered: table.rowsRendered,
      ...(table.truncated.length > 0 ? { truncated: table.truncated } : {}),
      redacted_cells: table.redactedCells,
      section: table.section,
    };
  }
  return { path, extracted: false, format: extraction.format, reason: extraction.reason };
}

/** The "not extracted" line, with the detail when there is one. */
function notExtractedLine(reason: string, detail?: string): string {
  return `  not extracted: ${reason}${detail !== undefined ? ` (${oneLine(detail)})` : ""}`;
}

/** The text output for `path`, one entry per line. */
function extractionText(path: string, extraction: SourceExtraction): string[] {
  const lines = [`extract: ${path} (${extraction.format ?? UNKNOWN_FORMAT_LABEL})`];
  if (extraction.extractor === SOURCE_EXTRACTOR.html) {
    const html = extraction.html;
    if (!html.extracted) return [...lines, notExtractedLine(html.reason)];
    if (html.title !== null) lines.push(`  title: ${html.title}`);
    lines.push(`  ${html.parts.length} part(s)${html.parts.length > 0 ? ":" : ""}`);
    for (const part of html.parts) lines.push(`    ${formatPartLine(part)}`);
    if (html.partsOmitted > 0) lines.push(`  ${html.partsOmitted} more part(s) omitted`);
    return lines;
  }
  if (extraction.extractor === SOURCE_EXTRACTOR.table) {
    const table = extraction.table;
    if (!table.rendered) return [...lines, notExtractedLine(table.reason, table.detail)];
    const truncated =
      table.truncated.length > 0 ? `, truncated: ${table.truncated.join(", ")}` : "";
    lines.push(
      `  ${table.delimiter}-delimited, ${table.columns} column(s), ${table.rows} row(s), ` +
        `${table.rowsRendered} rendered, ${table.redactedCells} redacted cell(s)${truncated}`,
      table.section,
    );
    return lines;
  }
  return [...lines, notExtractedLine(extraction.reason)];
}

export async function runBrainExtract(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    json: { type: "boolean" },
  });
  const file = positional[0];
  if (!file) return usageError(USAGE);

  try {
    const extraction = extractFile(file);
    if (flags["json"]) {
      okJson(extractionJson(file, extraction));
      return 0;
    }
    for (const line of extractionText(file, extraction)) ok(line);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
