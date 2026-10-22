/**
 * Undated-quantity recognizer (write-honesty, F4, t_fb442a24).
 *
 * A count or amount written with no date becomes a claim that answers as
 * true at every instant: `isValidAt` treats an absent `valid_from` as
 * unbounded, so `5,000 users` written last year reads identically today.
 * This module owns the RECOGNITION half only - the write-time lint
 * (`page-lint.ts`) decides the escape hatches and emits the finding, and
 * the claims surface is where a reader places the claim in time.
 *
 * ## Structural shapes only
 *
 * The vocabulary is structural, matching the invariant
 * `search/temporal-intent.ts` states for the read side: no natural-language
 * date or unit phrase is recognised. The trigger classes are the four
 * high-precision shapes a writer actually types -
 *
 *   - a currency amount, by symbol (`$4.2M`) or ISO code (`10 USD`);
 *   - a percentage (`35%`);
 *   - a number with a unit from the declared structural set (`359 ms`,
 *     `5,000 users`, `512 MB`);
 *   - a bare thousands-separated count (`12,400`).
 *
 * Everything else is left alone. A number inside an ISO date or instant, a
 * version string (`v1.73.0`), a URL, a Markdown link destination, a
 * wikilink target, an ordered-list marker, a table row, an inline code
 * span, a fenced block and the frontmatter block are masked before the
 * scan, because a number there is not a claim about the vault. Precision
 * is deliberate: a missed quantity costs one advisory, a hallucinated one
 * teaches the operator to ignore the list.
 *
 * Pure and deterministic: the same body yields the same lexemes and
 * offsets. An offset is a UTF-16 code-unit index into the string handed
 * to {@link findUndatedQuantities}. On the write path that string is the
 * page body after the frontmatter block is stripped and the remainder
 * trimmed, so an offset is neither a file offset nor an index into the
 * raw text a write call received; the write-time lint names that
 * coordinate system in its message.
 */

import { WIKILINK_TARGET_RE } from "./wikilink.ts";

/** One quantity the authored body states without a date. */
export interface UndatedQuantity {
  /** The matched text exactly as written. */
  readonly lexeme: string;
  /**
   * UTF-16 code-unit offset of the first character of {@link lexeme},
   * counted within the string the caller passed in - after frontmatter
   * removal on the write path, never a file offset.
   */
  readonly offset: number;
}

/**
 * Unit words and symbols that make a preceding number a quantity. A closed
 * structural set, not a language model: an unknown word after a number is
 * not a unit. Longest-first matching is built from this list, so `seconds`
 * is never read as `s` followed by prose.
 */
const QUANTITY_UNITS: ReadonlyArray<string> = Object.freeze([
  // Duration.
  "ms",
  "s",
  "sec",
  "secs",
  "second",
  "seconds",
  "min",
  "mins",
  "minute",
  "minutes",
  "h",
  "hr",
  "hrs",
  "hour",
  "hours",
  "d",
  "day",
  "days",
  "wk",
  "wks",
  "week",
  "weeks",
  "mo",
  "mos",
  "month",
  "months",
  "yr",
  "yrs",
  "year",
  "years",
  // Data size.
  "b",
  "byte",
  "bytes",
  "kb",
  "mb",
  "gb",
  "tb",
  "kib",
  "mib",
  "gib",
  "tib",
  "kb/s",
  "mb/s",
  "gb/s",
  // Counts and throughput.
  "user",
  "users",
  "item",
  "items",
  "row",
  "rows",
  "page",
  "pages",
  "file",
  "files",
  "request",
  "requests",
  "req",
  "reqs",
  "rps",
  "qps",
  "op",
  "ops",
  "call",
  "calls",
  "token",
  "tokens",
  "char",
  "chars",
  "character",
  "characters",
  "word",
  "words",
  "line",
  "lines",
  "node",
  "nodes",
  "edge",
  "edges",
  "point",
  "points",
  "record",
  "records",
  "entry",
  "entries",
  "result",
  "results",
  "hit",
  "hits",
  "download",
  "downloads",
  "install",
  "installs",
  "visitor",
  "visitors",
  "view",
  "views",
  "session",
  "sessions",
  "signal",
  "signals",
  "note",
  "notes",
  "preference",
  "preferences",
  // Ratio.
  "%",
]);

/**
 * Units that read as units with no space before them (`359ms`, `512 MB`,
 * `35%`): every unit of two characters or more, plus the percent sign,
 * whose glued spelling is the common one.
 */
const GLUED_QUANTITY_UNITS: ReadonlyArray<string> = Object.freeze(
  QUANTITY_UNITS.filter((unit) => unit.length > 1 || unit === "%"),
);

/**
 * The single-letter duration and size units (`3 d`, `72 h`). They need
 * whitespace before them: glued to the number they stop being units, and
 * a case-blind match with an optional space turned `3D` and `2D` (a
 * dimension) and `2b` (a plan) into quantities.
 */
const SPACED_QUANTITY_UNITS: ReadonlyArray<string> = Object.freeze(
  QUANTITY_UNITS.filter((unit) => unit.length === 1 && unit !== "%"),
);

/** ISO currency codes admitted after an amount (`10 USD`). */
const CURRENCY_CODES: ReadonlyArray<string> = Object.freeze([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "CNY",
  "INR",
  "SEK",
  "NOK",
  "PLN",
]);

/** Regex-escape one literal fragment used to build a pattern. */
function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest-first alternation, so a suffix unit cannot shadow a longer one. */
function alternation(values: ReadonlyArray<string>): string {
  return [...values]
    .toSorted((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapePattern)
    .join("|");
}

/**
 * ISO calendar-date run in prose. The digit and hyphen boundaries are the
 * same guard `search/temporal-intent.ts` uses: a date-shaped run inside a
 * longer digit run is not a date, while a date surrounded by any script
 * with no whitespace still is one. The set of accepted date VALUES is the
 * lifecycle module's (`lifecycle/temporal-replace.ts`); this module only
 * needs the shared shape for masking and for the escape hatch.
 */
const ISO_DATE_RUN = /(?<![0-9-])\d{4}-\d{2}-\d{2}(?![0-9-])/u;

/** ISO date or instant run, with an optional time and zone. */
const ISO_INSTANT_RUN =
  /(?<![0-9-])\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?(?![0-9-])/u;

/**
 * A version-like dotted run: `v1.73.0`, `1.73.0`, `192.168.1.1`. Two or
 * more dots is the structural difference from a decimal (`3.14159`), so an
 * IP address and a semantic version are both excluded without a table.
 * The leading lookbehind admits no dot before the first digit: in a run
 * like `1.1.1.1...` every position after a dot would otherwise be a legal
 * start, each running the whole tail - a quadratic scan of the
 * synchronous write path.
 */
const VERSION_RUN = /(?<![0-9A-Za-z_.])v?\d+(?:\.\d+){2,}(?![0-9A-Za-z_.])/iu;

/** Currency amount led by a symbol, with an optional magnitude suffix. */
const CURRENCY_SYMBOL_RUN =
  /(?<![0-9A-Za-z])[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?[KMBT](?![A-Za-z]))?/iu;

/**
 * Currency amount followed by an ISO code. The leading lookbehind admits
 * no comma before the first digit, for the same bounded-scan reason as
 * {@link VERSION_RUN}: in a comma-joined digit run every position after a
 * comma would otherwise be a legal start.
 */
const CURRENCY_CODE_RUN = new RegExp(
  `(?<![0-9A-Za-z_.,])[0-9][0-9,]*(?:\\.\\d+)?\\s?(?:${alternation(CURRENCY_CODES)})(?![A-Za-z])`,
  "iu",
);

/** Percentage, with the same comma-guarded leading lookbehind. */
const PERCENT_RUN = /(?<![0-9A-Za-z_.,])\d[\d,]*(?:\.\d+)?\s?%/u;

/**
 * Number followed by a unit from {@link QUANTITY_UNITS}, with the same
 * comma-guarded leading lookbehind as the other run shapes. A multi-char
 * unit (and `%`) may sit glued to the number; the single-letter units
 * ({@link SPACED_QUANTITY_UNITS}) require whitespace.
 */
const NUMBER_UNIT_RUN = new RegExp(
  // The year guard: a bare four-digit 19xx/20xx number is a YEAR far
  // more often than a count ("In 2024 users doubled"), and the lint is
  // precision-first. A thousands separator (`2,024 users`) or a longer
  // digit run is a number, not a year shape, and still fires.
  `(?<![0-9A-Za-z_.,])(?!(?:19|20)\\d{2}\\b)\\d[\\d,]*(?:\\.\\d+)?` +
    `(?:\\s?(?:${alternation(GLUED_QUANTITY_UNITS)})|\\s+(?:${alternation(SPACED_QUANTITY_UNITS)}))` +
    `(?![0-9A-Za-z_])`,
  "iu",
);

/**
 * Bare thousands-separated count, optionally with a decimal part. The
 * trailing lookahead rejects a following DIGIT (the run must end) and a
 * comma that ANOTHER DIGIT follows (still inside the count), but not a
 * prose comma - "the counter reads 12,400, then stops" states a count,
 * and rejecting every comma made the common shape invisible.
 */
const THOUSANDS_RUN = /(?<![0-9A-Za-z_,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![0-9]|,\d)/u;

/** Every trigger, in the order an equal-span tie prefers. */
const TRIGGER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  CURRENCY_SYMBOL_RUN,
  CURRENCY_CODE_RUN,
  PERCENT_RUN,
  NUMBER_UNIT_RUN,
  THOUSANDS_RUN,
]);

/** True when `text` carries an ISO date or instant anywhere in it. */
export function containsIsoDate(text: string): boolean {
  return ISO_DATE_RUN.test(text) || ISO_INSTANT_RUN.test(text);
}

/**
 * A URL run: scheme plus every non-whitespace character after it. The run
 * ends at whitespace, so it never crosses a line.
 */
const URL_RUN = /https?:\/\/\S+/giu;

/**
 * A Markdown inline link: `[text](destination)`. The bracketed text is
 * authored prose and stays scanned; only the destination is machine
 * addressing, where a number names a file or a fragment, not a count.
 */
const MD_LINK_RUN = /\[[^\]\n]*\]\(([^)\n]*)\)/gu;

interface Range {
  readonly start: number;
  readonly end: number;
}

/** A global copy of `pattern`, keeping every flag it already carries. */
function globalCopy(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
}

/** Append a match's span when the pattern finds one. */
function maskMatches(text: string, pattern: RegExp, into: Range[]): void {
  for (const match of text.matchAll(globalCopy(pattern))) {
    const start = match.index!;
    into.push({ start, end: start + match[0].length });
  }
}

/** True when the line carries an unescaped pipe, the table-cell boundary. */
function hasTablePipe(line: string): boolean {
  return /(?<!\\)\|/u.test(line);
}

/**
 * The spans of `text` that carry no authored claim: the frontmatter
 * block, fenced blocks, table rows, ordered-list markers, inline code
 * spans, URL runs, Markdown link destinations and wikilink targets.
 * Walked line by line because most of those exclusions are a LINE
 * property. The ISO-date and version masks are deliberately NOT applied
 * here: a date in prose is a dated claim - exactly what the escape hatch
 * in `page-lint.ts` looks for - so {@link containsProseIsoDate} can read
 * this view unfiltered.
 */
function structuralExclusionRanges(text: string): Range[] {
  const ranges: Range[] = [];

  // Frontmatter is a leading fence closed by another fence line. An
  // unclosed opening fence is prose to the vault parser, so it is not
  // masked here either.
  let scanFrom = 0;
  const open = /^---[ \t]*\r?\n/u.exec(text);
  if (open !== null) {
    const rest = text.slice(open[0].length);
    const close = /^---[ \t]*\r?$/mu.exec(rest);
    if (close !== null) {
      scanFrom = open[0].length + close.index + close[0].length;
      ranges.push({ start: 0, end: scanFrom });
    }
  }

  let inFence = false;
  let fenceMarker = "";
  let lineStart = scanFrom;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/u, "");
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line);

    if (inFence) {
      ranges.push({ start: lineStart, end: lineEnd });
      if (
        fence !== null &&
        fence[1]!.charCodeAt(0) === fenceMarker.charCodeAt(0) &&
        fence[1]!.length >= fenceMarker.length
      ) {
        inFence = false;
      }
    } else if (fence !== null) {
      inFence = true;
      fenceMarker = fence[1]!;
      ranges.push({ start: lineStart, end: lineEnd });
    } else {
      // A table row is excluded whole: every cell on it is tabular data,
      // and a quantity in one belongs to the table, not to the prose.
      if (hasTablePipe(line)) ranges.push({ start: lineStart, end: lineEnd });

      // An ordered-list marker is excluded by itself; the item's content
      // after it is still authored prose and still scanned.
      const marker = /^[ \t]{0,3}\d{1,9}[.)](?=[ \t])/u.exec(line);
      if (marker !== null) {
        ranges.push({ start: lineStart, end: lineStart + marker[0].length });
      }

      // Inline code spans, backtick runs on one line. The span is excluded
      // including its delimiters, which carry no quantity of their own.
      for (const span of line.matchAll(/(`+)([^`]*?)\1/gu)) {
        const start = lineStart + span.index!;
        ranges.push({ start, end: start + span[0].length });
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  // A URL run is machine addressing: its numbers name a path, a query or
  // a fragment, not a count of vault things.
  maskMatches(text, URL_RUN, ranges);

  // Markdown link destinations: group 1 sits immediately before the
  // closing paren of the match.
  for (const match of text.matchAll(globalCopy(MD_LINK_RUN))) {
    const dest = match[1] ?? "";
    if (dest.length === 0) continue;
    const start = match.index! + match[0].length - 1 - dest.length;
    ranges.push({ start, end: start + dest.length });
  }

  // Wikilink targets: group 1 follows the two-character opening bracket.
  // Only the target is masked here; the `|` alias and `#` anchor suffixes
  // stay unmasked by this loop, though a line carrying a pipe is already
  // masked whole as a table row above.
  for (const match of text.matchAll(globalCopy(WIKILINK_TARGET_RE))) {
    const target = match[1] ?? "";
    if (target.length === 0) continue;
    const start = match.index! + 2;
    ranges.push({ start, end: start + target.length });
  }

  return ranges;
}

/**
 * The masked spans of a document: every structural exclusion plus the
 * ISO-date, instant and version-like tokens a quantity scan must not
 * read as claims.
 */
function exclusionRanges(text: string): Range[] {
  const ranges = structuralExclusionRanges(text);
  maskMatches(text, ISO_DATE_RUN, ranges);
  maskMatches(text, ISO_INSTANT_RUN, ranges);
  maskMatches(text, VERSION_RUN, ranges);
  return ranges;
}

/**
 * True when `text` carries an ISO date or instant in a region the scanner
 * reads as authored prose. The escape hatch must see the page the way the
 * trigger scan does: a date inside a fenced block, an inline code span, a
 * table row, a URL or a wikilink target is not a claim about the vault,
 * so it must not quiet the undated quantities around it. The scope stays
 * page-wide - one prose date anywhere still dates the page.
 */
export function containsProseIsoDate(text: string): boolean {
  const excluded = structuralExclusionRanges(text);
  for (const pattern of [ISO_DATE_RUN, ISO_INSTANT_RUN]) {
    for (const match of text.matchAll(globalCopy(pattern))) {
      const start = match.index!;
      if (!isExcluded(excluded, start, start + match[0].length)) return true;
    }
  }
  return false;
}

/** True when `[start, end)` overlaps any excluded span. */
function isExcluded(ranges: ReadonlyArray<Range>, start: number, end: number): boolean {
  for (const range of ranges) {
    if (start < range.end && range.start < end) return true;
  }
  return false;
}

/**
 * Every undated quantity in `body`, in ascending offset order.
 *
 * Overlapping trigger classes are resolved to the single longest lexeme at
 * that offset (`5,000 users` is one quantity, not a count plus a unit), so
 * a caller never reports the same words twice. The scan is pure: the input
 * string is never modified and repeated calls return equal results.
 */
export function findUndatedQuantities(body: string): UndatedQuantity[] {
  const excluded = exclusionRanges(body);
  const candidates: Range[] = [];
  for (const pattern of TRIGGER_PATTERNS) {
    maskMatches(body, pattern, candidates);
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);

  const found: UndatedQuantity[] = [];
  let consumedTo = 0;
  for (const candidate of candidates) {
    if (candidate.start < consumedTo) continue;
    if (isExcluded(excluded, candidate.start, candidate.end)) continue;
    found.push(
      Object.freeze({
        lexeme: body.slice(candidate.start, candidate.end),
        offset: candidate.start,
      }),
    );
    consumedTo = candidate.end;
  }
  return found;
}
