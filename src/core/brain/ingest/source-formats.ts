/**
 * The one registry of source formats ingest knows by extension.
 *
 * Every question "what is this file, and can ingest read it" is answered
 * here, from a table, never from prose: the batch planner derives its default
 * extension set and its per-file format skips from it, and the extraction
 * dispatch (`extract-source.ts`) switches on a spec's extractor. A format
 * the registry names with no extractor (PDF, Office, EPUB, RTF, images) is
 * reported by name as `format-not-extractable` instead of being counted as
 * an anonymous `unclassifiable` extension.
 *
 * A Node-safe leaf: no Bun runtime API, no I/O, only type imports, because part of
 * `src/` is bundled for Node and both the planner and the CLI read it.
 */

/**
 * Every format the registry names. Markdown and the lightweight markups map
 * to `text`: they are read as they are. Closed four-piece vocabulary
 * (census row `SOURCE_FORMAT`): the token crosses the MCP wire and the CLI
 * JSON verbatim.
 */
export const SOURCE_FORMAT = Object.freeze({
  text: "text",
  csv: "csv",
  tsv: "tsv",
  html: "html",
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  odt: "odt",
  ods: "ods",
  odp: "odp",
  epub: "epub",
  rtf: "rtf",
  image: "image",
} as const);

/** The closed union of format tokens. */
export type SourceFormat = (typeof SOURCE_FORMAT)[keyof typeof SOURCE_FORMAT];

/** Membership list of {@link SOURCE_FORMAT}, in registry order. */
export const SOURCE_FORMATS: ReadonlyArray<SourceFormat> = Object.freeze(
  Object.values(SOURCE_FORMAT),
);

/** Membership guard of {@link SOURCE_FORMATS}. */
export function isSourceFormat(value: unknown): value is SourceFormat {
  return typeof value === "string" && (SOURCE_FORMATS as ReadonlyArray<string>).includes(value);
}

/**
 * How ingest reads a format: `verbatim` (the text is the source), `html` (the
 * linear HTML scanner) or `table` (the CSV and TSV table note). Not a reason
 * vocabulary - it never crosses a wire as a verdict - so it has no member
 * list and no guard.
 */
export const SOURCE_EXTRACTOR = Object.freeze({
  verbatim: "verbatim",
  html: "html",
  table: "table",
} as const);

/** The closed union of extractor tokens. */
export type SourceExtractor = (typeof SOURCE_EXTRACTOR)[keyof typeof SOURCE_EXTRACTOR];

/** One registered format: its extractor (`null`: named, not extracted) and extensions. */
export interface SourceFormatSpec {
  readonly format: SourceFormat;
  readonly extractor: SourceExtractor | null;
  /** Lowercase, dot-prefixed. */
  readonly extensions: ReadonlyArray<string>;
}

function spec(
  format: SourceFormat,
  extractor: SourceExtractor | null,
  extensions: ReadonlyArray<string>,
): SourceFormatSpec {
  return Object.freeze({ format, extractor, extensions: Object.freeze([...extensions]) });
}

/** The registry, one spec per format, in {@link SOURCE_FORMAT} order. */
export const SOURCE_FORMAT_SPECS: ReadonlyArray<SourceFormatSpec> = Object.freeze([
  spec(SOURCE_FORMAT.text, SOURCE_EXTRACTOR.verbatim, [
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".rst",
    ".org",
  ]),
  spec(SOURCE_FORMAT.csv, SOURCE_EXTRACTOR.table, [".csv"]),
  spec(SOURCE_FORMAT.tsv, SOURCE_EXTRACTOR.table, [".tsv"]),
  spec(SOURCE_FORMAT.html, SOURCE_EXTRACTOR.html, [".html", ".htm"]),
  spec(SOURCE_FORMAT.pdf, null, [".pdf"]),
  spec(SOURCE_FORMAT.docx, null, [".docx"]),
  spec(SOURCE_FORMAT.xlsx, null, [".xlsx"]),
  spec(SOURCE_FORMAT.pptx, null, [".pptx"]),
  spec(SOURCE_FORMAT.odt, null, [".odt"]),
  spec(SOURCE_FORMAT.ods, null, [".ods"]),
  spec(SOURCE_FORMAT.odp, null, [".odp"]),
  spec(SOURCE_FORMAT.epub, null, [".epub"]),
  spec(SOURCE_FORMAT.rtf, null, [".rtf"]),
  spec(SOURCE_FORMAT.image, null, [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".heic",
  ]),
]);

const SPEC_BY_FORMAT: ReadonlyMap<SourceFormat, SourceFormatSpec> = new Map(
  SOURCE_FORMAT_SPECS.map((s) => [s.format, s]),
);

/** Every registered extension mapped to its format. */
export const SOURCE_FORMAT_BY_EXTENSION: ReadonlyMap<string, SourceFormat> = new Map(
  SOURCE_FORMAT_SPECS.flatMap((s) => s.extensions.map((ext) => [ext, s.format] as const)),
);

/** The forward-slash path separator a Windows backslash is folded to. */
const PATH_SEPARATOR = "/";
const EXTENSION_MARK = ".";

/**
 * The lowercased extension of the last path segment, `""` when it has none
 * (a dotfile name such as `.env` has none either). Both separators count, so
 * a Windows path reads the same as a POSIX one.
 */
function extensionOf(path: string): string {
  const base = path.slice(path.replaceAll("\\", PATH_SEPARATOR).lastIndexOf(PATH_SEPARATOR) + 1);
  const dot = base.lastIndexOf(EXTENSION_MARK);
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * The registered format of `path`, by the lowercased extension of its last
 * segment, or `null` when the extension is absent or unregistered. A URL is
 * judged by its last segment like any path, so one whose last segment carries
 * no registered extension answers `null`.
 */
export function sourceFormatOf(path: string): SourceFormat | null {
  const ext = extensionOf(path);
  if (ext.length === 0) return null;
  return SOURCE_FORMAT_BY_EXTENSION.get(ext) ?? null;
}

/** The registry spec of `format`. */
export function sourceFormatSpec(format: SourceFormat): SourceFormatSpec {
  const found = SPEC_BY_FORMAT.get(format);
  if (found === undefined) {
    // Unreachable for a typed caller; a cast value that is no format is a
    // caller error and is named, never mapped to a guess.
    throw new TypeError(`unknown source format: ${String(format)}`);
  }
  return found;
}

/**
 * The extensions batch planning discovers by default: every extension of a
 * spec with an extractor, in spec order (the six text extensions first).
 */
export const DEFAULT_INGESTIBLE_EXTENSIONS: readonly string[] = Object.freeze(
  SOURCE_FORMAT_SPECS.filter((s) => s.extractor !== null).flatMap((s) => s.extensions),
);

/**
 * Why a source's content was not extracted. Closed four-piece vocabulary
 * (census row `SOURCE_EXTRACT_SKIP_REASON`): "could not extract" is data on
 * the wire, never an error.
 */
export const SOURCE_EXTRACT_SKIP_REASON = Object.freeze({
  /** A text format: the source is read as it is, nothing to extract. */
  formatReadVerbatim: "format-read-verbatim",
  /** A format the registry names but has no extractor for. */
  formatNotExtractable: "format-not-extractable",
  /** An extension the registry does not name. */
  formatUnknown: "format-unknown",
  /** A URL, an absent file, a file outside the vault or one hidden from the caller. */
  sourceNotLocal: "source-not-local",
  /** Larger than the read limit. */
  sourceTooLarge: "source-too-large",
  /** A directory, FIFO or other non-regular file. */
  notARegularFile: "not-a-regular-file",
  /** The bytes are not valid UTF-8. */
  notUtf8: "not-utf8",
} as const);

/** The closed union of extract skip reasons. */
export type SourceExtractSkipReason =
  (typeof SOURCE_EXTRACT_SKIP_REASON)[keyof typeof SOURCE_EXTRACT_SKIP_REASON];

/** Membership list of {@link SOURCE_EXTRACT_SKIP_REASON}. */
export const SOURCE_EXTRACT_SKIP_REASONS: ReadonlyArray<SourceExtractSkipReason> = Object.freeze(
  Object.values(SOURCE_EXTRACT_SKIP_REASON),
);

/** Membership guard of {@link SOURCE_EXTRACT_SKIP_REASONS}. */
export function isSourceExtractSkipReason(value: unknown): value is SourceExtractSkipReason {
  return (
    typeof value === "string" &&
    (SOURCE_EXTRACT_SKIP_REASONS as ReadonlyArray<string>).includes(value)
  );
}
