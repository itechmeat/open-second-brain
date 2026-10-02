/**
 * Extraction dispatch and the derived section of a summary page.
 *
 * {@link extractSource} is the one place a source's bytes meet an extractor:
 * an exhaustive switch over the registry's extractor for the source's
 * format, so a format added to the registry with a new extractor does not
 * type-check until it has an arm here. {@link deriveSourceSection} is what
 * ingest writes from it onto a summary page: for an in-vault HTML, CSV or
 * TSV file the caller may read, the format, the content hash and one
 * section (`## Parts` or `## Table`); for every other source nothing.
 */

import { pageVisibility } from "../../graph/visibility.ts";
import type { FrontmatterMap } from "../../types.ts";
import { FRONTMATTER_RE, parseFrontmatterText } from "../../vault.ts";
import { isSourceHidden, readSourceOrigin, SourceTrustError } from "../intake/source-trust.ts";
import {
  INTAKE_TRUST,
  type IntakeTrust,
  sourceContentHashFrontmatter,
} from "../trust/untrusted-provenance.ts";
import { extractHtml, type HtmlExtractResult, renderPartsSection } from "./extract-html.ts";
import {
  SOURCE_EXTRACT_SKIP_REASON,
  SOURCE_EXTRACTOR,
  SOURCE_FORMAT,
  type SourceExtractSkipReason,
  type SourceFormat,
  sourceFormatOf,
  sourceFormatSpec,
} from "./source-formats.ts";
import {
  type TableFormat,
  tableNote,
  tableNoteFrontmatter,
  type TableNoteRendered,
  type TableNoteResult,
  type TableNoteSkipped,
} from "./table-note.ts";

/** What the dispatch made of one source's bytes. */
export type SourceExtraction =
  | {
      readonly extractor: typeof SOURCE_EXTRACTOR.html;
      readonly format: SourceFormat;
      readonly html: HtmlExtractResult;
    }
  | {
      readonly extractor: typeof SOURCE_EXTRACTOR.table;
      readonly format: SourceFormat;
      readonly table: TableNoteResult;
    }
  | {
      readonly extractor: null | typeof SOURCE_EXTRACTOR.verbatim;
      readonly format: SourceFormat | null;
      readonly reason: SourceExtractSkipReason;
    };

/**
 * Dispatch `bytes` addressed by `path` to the extractor its format names.
 * An unregistered extension answers `format-unknown` with no format; a text
 * format is read verbatim and a named format without an extractor is
 * `format-not-extractable`. Pure: no I/O.
 */
export function extractSource(path: string, bytes: Uint8Array): SourceExtraction {
  const format = sourceFormatOf(path);
  if (format === null) {
    return { extractor: null, format: null, reason: SOURCE_EXTRACT_SKIP_REASON.formatUnknown };
  }
  const spec = sourceFormatSpec(format);
  switch (spec.extractor) {
    case null:
      return {
        extractor: null,
        format: spec.format,
        reason: SOURCE_EXTRACT_SKIP_REASON.formatNotExtractable,
      };
    case SOURCE_EXTRACTOR.verbatim:
      return {
        extractor: spec.extractor,
        format: spec.format,
        reason: SOURCE_EXTRACT_SKIP_REASON.formatReadVerbatim,
      };
    case SOURCE_EXTRACTOR.html:
      return {
        extractor: spec.extractor,
        format: spec.format,
        html: extractHtmlAfterFrontmatter(bytes),
      };
    case SOURCE_EXTRACTOR.table:
      return {
        extractor: spec.extractor,
        format: spec.format,
        table: tableNote(path, withoutLeadingFrontmatter(bytes).bytes),
      };
  }
}

/** The UTF-8 byte-order mark, which may precede a leading frontmatter block. */
const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf]);
/** The first bytes of a frontmatter block. */
const FRONTMATTER_FENCE = "---";
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Invalid bytes become U+FFFD, as in a page read as text; the mark is kept for the parser. */
const UTF8_LENIENT = new TextDecoder("utf-8", { ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

/**
 * `bytes` without one leading frontmatter block (after an optional
 * byte-order mark), so the block is never rendered as source data: a CSV
 * header of `---` or a `visibility: private` row. `skipped` is the number
 * of bytes left out (the mark and the block), 0 when nothing is. Bytes that
 * are not UTF-8 or open with no closed block are returned as they are, and
 * the extractor answers for them.
 */
function withoutLeadingFrontmatter(bytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly skipped: number;
} {
  const whole = { bytes, skipped: 0 };
  const bom = UTF8_BOM.every((byte, i) => bytes[i] === byte) ? UTF8_BOM.length : 0;
  for (let i = 0; i < FRONTMATTER_FENCE.length; i++) {
    if (bytes[bom + i] !== FRONTMATTER_FENCE.charCodeAt(i)) return whole;
  }
  let text: string;
  try {
    text = UTF8_STRICT.decode(bytes.subarray(bom));
  } catch {
    return whole;
  }
  // The vault's own frontmatter pattern, so the block the reach predicate
  // reads a source's visibility from is exactly the block withheld here.
  const block = FRONTMATTER_RE.exec(text);
  if (block === null) return whole;
  const skipped = bom + UTF8_ENCODER.encode(block[0]).length;
  return { bytes: bytes.subarray(skipped), skipped };
}

/** The HTML extraction of `bytes` after any leading frontmatter block, offsets counted in the whole file. */
function extractHtmlAfterFrontmatter(bytes: Uint8Array): HtmlExtractResult {
  const rest = withoutLeadingFrontmatter(bytes);
  return extractHtml(rest.bytes, rest.skipped);
}

/** The HTML outcome on an ingest result: counts only, never the text. */
export type PartsOutcome =
  | { readonly extracted: true; readonly count: number; readonly omitted?: number }
  | { readonly extracted: false; readonly reason: SourceExtractSkipReason };

/** The table outcome on an ingest result: the rendering's counts, never its rows. */
export type TableOutcome = Omit<TableNoteRendered, "section"> | TableNoteSkipped;

/** What ingest adds to a summary page for a source with a derived section. */
export interface SourceDerivation {
  readonly format: SourceFormat;
  /** `source_format`, `source_content_hash`, then the table keys; empty when nothing was read. */
  readonly frontmatter: FrontmatterMap;
  /** The section written last on the page; `""` when there is none. */
  readonly section: string;
  readonly parts?: PartsOutcome;
  readonly table?: TableOutcome;
  /**
   * The source's own visibility tokens, present only when it declares some:
   * a page that copies source content is at most as visible as the source.
   */
  readonly visibility?: readonly string[];
}

/** Frontmatter key naming a derived page's source format. */
export const SOURCE_FORMAT_FRONTMATTER_KEY = "source_format";

/** Is this registered format one the table extractor reads? */
function isTableFormat(format: SourceFormat): format is TableFormat {
  return format === SOURCE_FORMAT.csv || format === SOURCE_FORMAT.tsv;
}

/** The derivation of a source whose bytes were not read: no keys, no section. */
function notLocal(format: SourceFormat): SourceDerivation {
  const reason = SOURCE_EXTRACT_SKIP_REASON.sourceNotLocal;
  if (isTableFormat(format)) {
    return { format, frontmatter: {}, section: "", table: { rendered: false, format, reason } };
  }
  return { format, frontmatter: {}, section: "", parts: { extracted: false, reason } };
}

/** The parts outcome and section of an HTML extraction. */
function fromHtml(html: HtmlExtractResult): { parts: PartsOutcome; section: string } {
  if (!html.extracted) return { parts: { extracted: false, reason: html.reason }, section: "" };
  const parts: PartsOutcome =
    html.partsOmitted > 0
      ? { extracted: true, count: html.parts.length, omitted: html.partsOmitted }
      : { extracted: true, count: html.parts.length };
  return { parts, section: renderPartsSection(html) };
}

/** The table outcome, extra keys and section of a table note. */
function fromTable(table: TableNoteResult): {
  table: TableOutcome;
  frontmatter: FrontmatterMap;
  section: string;
} {
  if (!table.rendered) return { table, frontmatter: {}, section: "" };
  const { section, ...counts } = table;
  return { table: counts, frontmatter: tableNoteFrontmatter(table), section };
}

/**
 * The derived section of the summary page for `source`, or `undefined` when
 * its format has no derived section (text, an unregistered extension, a
 * named format without an extractor): those pages are written exactly as
 * before.
 *
 * The order is the reach order: the format first (it reads nothing), then
 * the trusted lane, then the caller's reach, then ONE read whose digest
 * covers exactly the bytes extracted. A URL, an absent file and a file the
 * caller may not read all answer `source-not-local` with no digest and no
 * section, so the page cannot tell them apart.
 */
export function deriveSourceSection(
  vault: string,
  source: string,
  trust: IntakeTrust,
  readable?: (rel: string) => boolean,
): SourceDerivation | undefined {
  const format = sourceFormatOf(source);
  if (format === null) return undefined;
  const extractor = sourceFormatSpec(format).extractor;
  if (extractor !== SOURCE_EXTRACTOR.html && extractor !== SOURCE_EXTRACTOR.table) {
    return undefined;
  }
  if (trust !== INTAKE_TRUST.trusted || isSourceHidden(vault, source, readable)) {
    return notLocal(format);
  }
  let origin: ReturnType<typeof readSourceOrigin>;
  try {
    origin = readSourceOrigin(vault, source);
  } catch (cause) {
    // The intake already read this source; a refusal now (it grew past the
    // digest ceiling, or stopped being readable, between the two reads) is
    // the source not being there to derive from, not a reason to fail an
    // ingest whose entity pages are already written.
    if (cause instanceof SourceTrustError) return notLocal(format);
    throw cause;
  }
  if (origin.bytes === undefined || origin.contentHash === undefined) return notLocal(format);

  const base: FrontmatterMap = {
    [SOURCE_FORMAT_FRONTMATTER_KEY]: format,
    ...sourceContentHashFrontmatter(origin.contentHash),
  };
  const visibility = sourceVisibility(origin.bytes);
  const reach = visibility.length > 0 ? { visibility } : {};
  const extraction = extractSource(source, origin.bytes);
  if ("html" in extraction) {
    const { parts, section } = fromHtml(extraction.html);
    return { format, frontmatter: base, section, parts, ...reach };
  }
  if ("table" in extraction) {
    const derived = fromTable(extraction.table);
    return {
      format,
      frontmatter: { ...base, ...derived.frontmatter },
      section: derived.section,
      table: derived.table,
      ...reach,
    };
  }
  // The registry gave this format an html or table extractor above, so the
  // dispatch answered with that arm; anything else is a registry defect.
  throw new Error(`extractor ${extractor} answered without its arm for ${format}`);
}

/**
 * The visibility tokens the source's own frontmatter block declares, read
 * from the bytes the extractor strips that block from (so the two agree by
 * construction) and decoded the way the reach predicate
 * (`isPathReadableAtReach`) decodes a page: leniently, through the vault's
 * frontmatter parser.
 */
function sourceVisibility(bytes: Uint8Array): readonly string[] {
  const [meta] = parseFrontmatterText(UTF8_LENIENT.decode(bytes));
  return pageVisibility(meta);
}
