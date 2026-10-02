/**
 * HTML source extraction: the title, the visible text and the
 * heading-derived parts of one HTML file, from its bytes.
 *
 * A pure, linear scanner, not `HTMLRewriter`: that one leaves entities
 * undecoded, misses document-level text in element handlers, throws on
 * `onEndTag` for void elements and exists in Bun only, while this module
 * also runs in the Node build. Every step moves the cursor forward and no
 * regular expression runs over unbounded input, so the running time is
 * linear in the size of the source whatever its shape.
 *
 * The grammar, by decision: comments, the doctype and processing
 * instructions are dropped; raw-text elements and the elements in
 * {@link SKIPPED_ELEMENTS} contribute nothing; a `<private>` region, also
 * one inside a title or a textarea, becomes {@link PRIVATE_REGION_PLACEHOLDER};
 * numeric character references and the six named entities are decoded, any
 * other named entity is kept verbatim; block elements break lines, `pre`
 * keeps its whitespace and everywhere else whitespace collapses; `<title>`
 * is the title; no attribute value is ever emitted; CRLF and a lone CR
 * count as one line break; bytes that are not UTF-8 are refused by name.
 */

import { fenceFor } from "../../markdown-fence.ts";
import {
  PRIVATE_REGION_PLACEHOLDER,
  redactRawOutput,
  stripPrivateRegions,
} from "../../redactor.ts";
import { oneLine } from "../architect/manifests.ts";
import { SOURCE_HASH_MAX_BYTES } from "../intake/source-trust.ts";
import { SOURCE_EXTRACT_SKIP_REASON } from "./source-formats.ts";

/** The largest HTML source read for extraction, in bytes: the source hash ceiling. */
export const HTML_EXTRACT_MAX_SOURCE_BYTES = SOURCE_HASH_MAX_BYTES;
/** The most parts one extraction reports; the rest are counted in `partsOmitted`. */
export const HTML_PARTS_MAX = 256;
/**
 * The most headings the scan keeps: the parts cap plus one, so the last kept
 * part still takes its line span from the next heading. A heading past it is
 * only counted, never built, so a source of many small headings under long
 * ancestors costs no memory per omitted part.
 */
const HTML_SCANNED_MAX = HTML_PARTS_MAX + 1;
/** The longest heading (and title) kept, in code points; a longer one is cut. */
export const HTML_HEADING_MAX_CHARS = 200;

/**
 * One heading-derived part of the text. Level 0 is the preamble, the text
 * before the first heading. `trail` joins the headings of the enclosing
 * sections and this one with {@link TRAIL_SEPARATOR}. The line span is
 * 1-based and inclusive over the lines of the extracted text; it runs from
 * the heading to the line before the next part. `sourceOffset` is the UTF-8
 * byte offset of the heading's start tag in the source file (0 for the
 * preamble).
 */
export interface HtmlPart {
  readonly index: number;
  readonly level: number;
  readonly heading: string;
  readonly trail: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly sourceOffset: number;
}

export interface HtmlExtraction {
  readonly extracted: true;
  readonly title: string | null;
  readonly text: string;
  readonly parts: ReadonlyArray<HtmlPart>;
  readonly partsOmitted: number;
}

export type HtmlExtractResult =
  | HtmlExtraction
  | { readonly extracted: false; readonly reason: typeof SOURCE_EXTRACT_SKIP_REASON.notUtf8 };

/** Elements whose content is raw text up to their own end tag, never markup. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
]);
/** Elements whose content is text up to their own end tag, with entities decoded. */
const RCDATA_ELEMENTS: ReadonlySet<string> = new Set(["title", "textarea"]);
const TITLE_ELEMENT = "title";
const PRIVATE_ELEMENT = "private";
const PRE_ELEMENT = "pre";
const LINE_BREAK_ELEMENT = "br";
/** Elements whose whole subtree contributes no text and no part. */
const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set([
  "noscript",
  "template",
  "svg",
  "math",
  PRIVATE_ELEMENT,
]);
/** Elements that start and end a line of text. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  PRE_ELEMENT,
  "section",
  "summary",
  "table",
  "tbody",
  "textarea",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);
/** Heading elements by name, mapped to their level. */
const HEADING_LEVELS: ReadonlyMap<string, number> = new Map([
  ["h1", 1],
  ["h2", 2],
  ["h3", 3],
  ["h4", 4],
  ["h5", 5],
  ["h6", 6],
]);
/** The level of the preamble part, the text before the first heading. */
const PREAMBLE_LEVEL = 0;
/** Joins the headings of a part's enclosing sections into its trail. */
const TRAIL_SEPARATOR = " > ";

/** The `## Parts` section heading and the info string of its fenced block. */
const PARTS_SECTION_HEADING = "## Parts";
const PARTS_FENCE_INFO = "parts";
/** Separates a parts line's label from its span; escaped inside the label. */
const SPAN_SEPARATOR = "|";
const ESCAPED_SPAN_SEPARATOR = "\\|";
const ESCAPE_CHAR = "\\";
const ESCAPED_ESCAPE_CHAR = "\\\\";
/** How the preamble part is named in a parts line. */
const PREAMBLE_LABEL = "preamble";

/** Table cells: a word boundary, not a line break, so a row reads as one line. */
const CELL_ELEMENTS: ReadonlySet<string> = new Set(["td", "th"]);

/** Character references decoded by name; every other name is kept as written. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00A0"],
]);
/** What an invalid numeric character reference decodes to. */
const REPLACEMENT_CHARACTER = "�";
const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;
const BYTE_ORDER_MARK = 0xfeff;

const LINE_FEED = "\n";
const SPACE = " ";
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
/** What closes an abruptly closed empty comment `<!--->` after its opening. */
const EMPTY_COMMENT_TAIL = "->";
const END_TAG_OPEN = "</";
const TAG_CLOSE = ">";

const CHAR_LT = 0x3c; // <
const CHAR_GT = 0x3e; // >
const CHAR_AMP = 0x26; // &
const CHAR_SLASH = 0x2f; // /
const CHAR_BANG = 0x21; // !
const CHAR_QUESTION = 0x3f; // ?
const CHAR_HASH = 0x23; // #
const CHAR_SEMICOLON = 0x3b; // ;
const CHAR_QUOTE = 0x22; // "
const CHAR_APOSTROPHE = 0x27; // '
const CHAR_EQUALS = 0x3d; // =
const CHAR_CR = 0x0d;
const CHAR_LF = 0x0a;

const DECIMAL_RADIX = 10;
const HEX_RADIX = 16;

/** HTML whitespace: space, tab, line feed, form feed, carriage return. */
function isHtmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiHexDigit(code: number): boolean {
  return isAsciiDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiAlpha(code) || isAsciiDigit(code);
}

/** A character that ends a tag name: whitespace, `/` or `>`. */
function endsTagName(code: number): boolean {
  return isHtmlSpace(code) || code === CHAR_SLASH || code === CHAR_GT;
}

/** The strict decoder: a byte sequence that is not UTF-8 throws. The BOM is kept and skipped by the scanner, so byte offsets stay exact. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The lines of extracted text as they are emitted. Outside `pre` a run of
 * whitespace becomes one space and a line is trimmed when it ends; an
 * empty line is never kept. Inside `pre` every line break ends a line,
 * blank lines included.
 */
class LineSink {
  readonly lines: string[] = [];
  private current = "";
  private pendingSpace = false;

  /** Append text that collapses its whitespace. */
  appendFlowing(text: string): void {
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      const atEnd = i === text.length;
      if (!atEnd && !isHtmlSpace(text.charCodeAt(i))) continue;
      if (i > start) {
        if (this.pendingSpace && this.current.length > 0) this.current += SPACE;
        this.current += text.slice(start, i);
        this.pendingSpace = false;
      }
      if (!atEnd) this.pendingSpace = true;
      start = i + 1;
    }
  }

  /** Append preformatted text: whitespace kept, CRLF and lone CR read as one line break. */
  appendPreformatted(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code !== CHAR_LF && code !== CHAR_CR) continue;
      this.current += text.slice(start, i);
      this.lines.push(this.current);
      this.current = "";
      if (code === CHAR_CR && text.charCodeAt(i + 1) === CHAR_LF) i++;
      start = i + 1;
    }
    this.current += text.slice(start);
    this.pendingSpace = false;
  }

  /** A word boundary that collapses with any whitespace around it. */
  space(): void {
    this.pendingSpace = true;
  }

  /** End the current line; an empty one is dropped. */
  breakLine(): void {
    if (this.current.length > 0) this.lines.push(this.current);
    this.current = "";
    this.pendingSpace = false;
  }

  text(): string {
    this.breakLine();
    return this.lines.join(LINE_FEED);
  }
}

/** `text` with every whitespace run folded to one space, trimmed. */
function collapseWhitespace(text: string): string {
  const sink = new LineSink();
  sink.appendFlowing(text);
  return sink.text();
}

/**
 * The value pass over a heading or the title: key=value credentials and
 * URL userinfo. A heading is written to a summary page that search and
 * embeddings read, while the HTML file itself is never indexed.
 */
const HEADING_REDACTION = Object.freeze({ redactUrlCredentials: true });

/**
 * The code units of a heading or title the value pass reads: far wider than
 * {@link HTML_HEADING_MAX_CHARS}, so a credential the cap would split is
 * still seen whole, and bounded, so one megabyte-sized heading costs no
 * more than a short one.
 */
const HEADING_SCAN_MAX_CHARS = 4_096;

/** The last code point of a heading cut by the window or the cap. */
const CUT_MARK = "…";

/**
 * A folded heading or title as it is kept: its first
 * {@link HEADING_SCAN_MAX_CHARS} code units redacted, folded onto one line
 * again (the redactor's own notices carry line breaks), then cut to
 * {@link HTML_HEADING_MAX_CHARS} code points. A heading longer than the
 * window ends in the cut mark even when its redacted window is short.
 */
function keptHeading(folded: string): string {
  const windowCut = folded.length > HEADING_SCAN_MAX_CHARS;
  const window = windowCut ? codePointPrefix(folded, HEADING_SCAN_MAX_CHARS) : folded;
  const kept = oneLine(redactRawOutput(window, HEADING_REDACTION));
  return capCodePoints(windowCut ? `${kept}${CUT_MARK}` : kept, HTML_HEADING_MAX_CHARS);
}

/** The first `max` code units of `text`, one fewer when the cut would split a surrogate pair. */
function codePointPrefix(text: string, max: number): string {
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** `text` cut to `max` code points, the last one the cut mark when anything was cut. */
function capCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max - 1).join("")}${CUT_MARK}`;
}

/**
 * The character reference in `s` starting at `start` (an `&`): its decoded
 * text and the index after it. Anything that is not a reference is the
 * literal text it spans.
 */
function decodeReference(
  s: string,
  start: number,
): { readonly text: string; readonly end: number } {
  let k = start + 1;
  if (s.charCodeAt(k) === CHAR_HASH) {
    k++;
    const hex = s.charCodeAt(k) === 0x78 || s.charCodeAt(k) === 0x58; // x or X
    if (hex) k++;
    const digitsStart = k;
    let value = 0;
    while (
      k < s.length &&
      (hex ? isAsciiHexDigit(s.charCodeAt(k)) : isAsciiDigit(s.charCodeAt(k)))
    ) {
      // Saturate above the largest code point: the digits are still consumed.
      if (value <= MAX_CODE_POINT) {
        value = value * (hex ? HEX_RADIX : DECIMAL_RADIX) + Number.parseInt(s[k]!, HEX_RADIX);
      }
      k++;
    }
    if (k === digitsStart) return { text: s.slice(start, k), end: k };
    if (s.charCodeAt(k) === CHAR_SEMICOLON) k++;
    const valid =
      value !== 0 && value <= MAX_CODE_POINT && (value < SURROGATE_FIRST || value > SURROGATE_LAST);
    return { text: valid ? String.fromCodePoint(value) : REPLACEMENT_CHARACTER, end: k };
  }
  while (k < s.length && isAsciiAlphanumeric(s.charCodeAt(k))) k++;
  if (k === start + 1 || s.charCodeAt(k) !== CHAR_SEMICOLON) {
    return { text: s.slice(start, k), end: k };
  }
  const named = NAMED_ENTITIES.get(s.slice(start + 1, k));
  return { text: named ?? s.slice(start, k + 1), end: k + 1 };
}

/** `text` with its character references decoded. */
function decodeAll(text: string): string {
  let out = "";
  let k = 0;
  while (k < text.length) {
    const amp = text.indexOf("&", k);
    if (amp === -1) return out + text.slice(k);
    out += text.slice(k, amp);
    const decoded = decodeReference(text, amp);
    out += decoded.text;
    k = decoded.end;
  }
  return out;
}

/**
 * UTF-8 byte offsets of increasing indices into a string decoded from
 * valid UTF-8 (surrogates always paired). Each call resumes where the
 * last stopped, so converting every offset of a scan stays linear.
 */
class ByteOffsets {
  private index = 0;
  private bytes = 0;

  constructor(private readonly source: string) {}

  at(index: number): number {
    const s = this.source;
    while (this.index < index) {
      const code = s.charCodeAt(this.index);
      if (code < 0x80) this.bytes += 1;
      else if (code < 0x800) this.bytes += 2;
      else if (code >= SURROGATE_FIRST && code < 0xdc00) {
        this.bytes += 4;
        this.index++;
      } else this.bytes += 3;
      this.index++;
    }
    return this.bytes;
  }
}

/** A heading as the scan met it, before spans, the cap on parts and indices. */
interface ScannedPart {
  readonly level: number;
  readonly heading: string;
  readonly trail: string;
  readonly lineStart: number;
  readonly sourceOffset: number;
}

/** A heading whose end tag has not been met yet. */
interface OpenHeading {
  readonly level: number;
  readonly sourceOffset: number;
  /** The number of lines emitted before the heading's first line. */
  readonly linesBefore: number;
}

/**
 * The scanner state. One instance per call; `run` walks the source once.
 */
class HtmlScanner {
  private readonly sink = new LineSink();
  private title: string | null = null;
  /** Names of the open skipped elements, innermost last. */
  private readonly skipped: string[] = [];
  private preDepth = 0;
  private i: number;
  private readonly offsets: ByteOffsets;
  private openHeading: OpenHeading | null = null;
  /** The enclosing sections of the next heading, outermost first. */
  private readonly sections: { readonly level: number; readonly heading: string }[] = [];
  private readonly scanned: ScannedPart[] = [];
  /** Headings met past {@link HTML_SCANNED_MAX}, counted and never built. */
  private unscanned = 0;

  /**
   * @param offsetBase the bytes of the file that precede `source` (a
   *   leading frontmatter block left out), added to every heading offset.
   */
  constructor(
    private readonly source: string,
    private readonly offsetBase: number,
  ) {
    this.i = source.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
    this.offsets = new ByteOffsets(source);
  }

  run(): HtmlExtraction {
    const s = this.source;
    while (this.i < s.length) {
      const next = this.nextMarkup(this.i);
      if (next > this.i) this.emitText(s.slice(this.i, next));
      this.i = next;
      if (this.i >= s.length) break;
      if (s.charCodeAt(this.i) === CHAR_AMP) this.readReference();
      else this.readMarkup();
    }
    this.sink.breakLine();
    this.closeHeading();
    const text = this.sink.text();
    const all = this.partsWithSpans(this.sink.lines.length);
    const parts = all.slice(0, HTML_PARTS_MAX);
    return {
      extracted: true,
      title: this.title,
      text,
      parts,
      partsOmitted: all.length - parts.length + this.unscanned,
    };
  }

  /**
   * Every part, the preamble first when text precedes the first heading,
   * each spanning to the line before the next part (the last one to the
   * last line of the text).
   */
  private partsWithSpans(totalLines: number): HtmlPart[] {
    const first = this.scanned[0];
    const ordered: ScannedPart[] =
      first !== undefined && first.lineStart > 1
        ? [
            {
              level: PREAMBLE_LEVEL,
              heading: "",
              trail: "",
              lineStart: 1,
              sourceOffset: 0,
            },
            ...this.scanned,
          ]
        : this.scanned;
    return ordered.map((part, index) => ({
      index,
      level: part.level,
      heading: part.heading,
      trail: part.trail,
      lineStart: part.lineStart,
      lineEnd: (ordered[index + 1]?.lineStart ?? totalLines + 1) - 1,
      sourceOffset: part.sourceOffset,
    }));
  }

  /** End the open heading: an empty one is no part. */
  private closeHeading(): void {
    const open = this.openHeading;
    if (open === null) return;
    this.openHeading = null;
    const folded = oneLine(this.sink.lines.slice(open.linesBefore).join(SPACE));
    if (folded.length === 0) return;
    if (this.scanned.length >= HTML_SCANNED_MAX) {
      this.unscanned++;
      return;
    }
    const heading = keptHeading(folded);
    while ((this.sections.at(-1)?.level ?? PREAMBLE_LEVEL) >= open.level) this.sections.pop();
    this.sections.push({ level: open.level, heading });
    this.scanned.push({
      level: open.level,
      heading,
      trail: this.sections.map((section) => section.heading).join(TRAIL_SEPARATOR),
      lineStart: open.linesBefore + 1,
      sourceOffset: open.sourceOffset,
    });
  }

  /** The index of the next `<` or `&` at or after `from`, or the end. */
  private nextMarkup(from: number): number {
    const s = this.source;
    for (let k = from; k < s.length; k++) {
      const code = s.charCodeAt(k);
      if (code === CHAR_LT || code === CHAR_AMP) return k;
    }
    return s.length;
  }

  private emitText(text: string): void {
    if (this.skipped.length > 0) return;
    if (this.preDepth > 0) this.sink.appendPreformatted(text);
    else this.sink.appendFlowing(text);
  }

  /** Decode the character reference at `this.i` (an `&`) and emit it. */
  private readReference(): void {
    const decoded = decodeReference(this.source, this.i);
    this.emitText(decoded.text);
    this.i = decoded.end;
  }

  /** Read the markup at `this.i` (a `<`): a tag, a comment, a declaration, or text. */
  private readMarkup(): void {
    const s = this.source;
    const start = this.i;
    const after = s.charCodeAt(start + 1);
    if (s.startsWith(COMMENT_OPEN, start)) {
      const body = start + COMMENT_OPEN.length;
      // `<!-->` and `<!--->` are empty comments (HTML: abrupt closing).
      if (s.charCodeAt(body) === CHAR_GT) this.i = body + 1;
      else if (s.startsWith(EMPTY_COMMENT_TAIL, body)) this.i = body + EMPTY_COMMENT_TAIL.length;
      else this.i = this.indexAfter(COMMENT_CLOSE, body);
    } else if (after === CHAR_BANG || after === CHAR_QUESTION) {
      this.i = this.indexAfter(TAG_CLOSE, start + 2);
    } else if (after === CHAR_SLASH) {
      if (s.charCodeAt(start + 2) === CHAR_GT) {
        this.i = start + 3; // `</>` is nothing
      } else if (isAsciiAlpha(s.charCodeAt(start + 2))) {
        const name = this.readTagName(start + 2);
        this.i = this.indexAfter(TAG_CLOSE, start + 2 + name.length);
        this.endTag(name);
      } else {
        this.i = this.indexAfter(TAG_CLOSE, start + 2); // a bogus comment
      }
    } else if (isAsciiAlpha(after)) {
      const name = this.readTagName(start + 1);
      const { end, selfClosing } = this.skipAttributes(start + 1 + name.length);
      this.i = end;
      this.startTag(name, start, selfClosing);
    } else {
      this.emitText("<");
      this.i = start + 1;
    }
  }

  /** The index just past the next `needle` at or after `from`, or the end. */
  private indexAfter(needle: string, from: number): number {
    const at = this.source.indexOf(needle, from);
    return at === -1 ? this.source.length : at + needle.length;
  }

  /** The lowercased tag name starting at `from`. */
  private readTagName(from: number): string {
    const s = this.source;
    let k = from;
    while (k < s.length && !endsTagName(s.charCodeAt(k))) k++;
    return s.slice(from, k).toLowerCase();
  }

  /**
   * Walk the attributes of a start tag from `from` to its closing `>`,
   * honouring quoted values (which may hold a `>`). Values are skipped,
   * never read. An unterminated tag runs to the end of the source.
   */
  private skipAttributes(from: number): { readonly end: number; readonly selfClosing: boolean } {
    const s = this.source;
    let k = from;
    let lastSignificant = -1;
    while (k < s.length) {
      const code = s.charCodeAt(k);
      if (code === CHAR_GT) return { end: k + 1, selfClosing: lastSignificant === CHAR_SLASH };
      if (code === CHAR_QUOTE || code === CHAR_APOSTROPHE) {
        if (lastSignificant === CHAR_EQUALS) {
          const close = s.indexOf(code === CHAR_QUOTE ? '"' : "'", k + 1);
          if (close === -1) return { end: s.length, selfClosing: false };
          k = close + 1;
          lastSignificant = code;
          continue;
        }
      }
      if (!isHtmlSpace(code)) lastSignificant = code;
      k++;
    }
    return { end: s.length, selfClosing: false };
  }

  /**
   * The content of a raw-text or RCDATA element opened just before
   * `this.i`, up to its own end tag (any case, then whitespace, `/` or
   * `>`); the cursor moves past that end tag, or to the end of the source.
   */
  private readUntilEndTag(name: string): string {
    const s = this.source;
    let from = this.i;
    for (;;) {
      const at = s.indexOf(END_TAG_OPEN, from);
      if (at === -1) {
        const content = s.slice(this.i);
        this.i = s.length;
        return content;
      }
      const nameEnd = at + END_TAG_OPEN.length + name.length;
      if (
        s.slice(at + END_TAG_OPEN.length, nameEnd).toLowerCase() === name &&
        (nameEnd >= s.length || endsTagName(s.charCodeAt(nameEnd)))
      ) {
        const content = s.slice(this.i, at);
        this.i = this.indexAfter(TAG_CLOSE, nameEnd);
        return content;
      }
      from = at + END_TAG_OPEN.length;
    }
  }

  private startTag(name: string, offset: number, selfClosing: boolean): void {
    if (RAW_TEXT_ELEMENTS.has(name)) {
      this.readUntilEndTag(name);
      return;
    }
    if (this.skipped.length > 0) {
      if (SKIPPED_ELEMENTS.has(name) && !selfClosing) this.skipped.push(name);
      return;
    }
    if (RCDATA_ELEMENTS.has(name)) {
      // Stripped after decoding, so an encoded `&lt;private&gt;` hides too (fail-closed).
      const content = stripPrivateRegions(decodeAll(this.readUntilEndTag(name)));
      if (name === TITLE_ELEMENT) {
        if (this.title === null) {
          const folded = oneLine(collapseWhitespace(content));
          if (folded.length > 0) this.title = keptHeading(folded);
        }
        return;
      }
      this.sink.breakLine();
      this.sink.appendFlowing(content);
      this.sink.breakLine();
      return;
    }
    if (SKIPPED_ELEMENTS.has(name)) {
      if (selfClosing) return;
      if (name === PRIVATE_ELEMENT) this.sink.appendFlowing(PRIVATE_REGION_PLACEHOLDER);
      this.skipped.push(name);
      return;
    }
    if (name === LINE_BREAK_ELEMENT) {
      this.sink.breakLine();
      return;
    }
    if (CELL_ELEMENTS.has(name)) {
      this.sink.space();
      return;
    }
    if (BLOCK_ELEMENTS.has(name)) this.sink.breakLine();
    const level = HEADING_LEVELS.get(name);
    if (level !== undefined) {
      this.closeHeading();
      this.openHeading = {
        level,
        sourceOffset: this.offsetBase + this.offsets.at(offset),
        linesBefore: this.sink.lines.length,
      };
    }
    if (name === PRE_ELEMENT) {
      this.preDepth++;
      this.skipLeadingLineBreak();
    }
  }

  /** A line break right after `<pre>` is not content (HTML parsing rule). */
  private skipLeadingLineBreak(): void {
    const s = this.source;
    if (s.charCodeAt(this.i) === CHAR_CR) this.i++;
    if (s.charCodeAt(this.i) === CHAR_LF) this.i++;
  }

  private endTag(name: string): void {
    if (this.skipped.length > 0) {
      if (this.skipped[this.skipped.length - 1] === name) this.skipped.pop();
      return;
    }
    if (CELL_ELEMENTS.has(name)) {
      this.sink.space();
      return;
    }
    if (BLOCK_ELEMENTS.has(name)) this.sink.breakLine();
    if (HEADING_LEVELS.has(name)) this.closeHeading();
    if (name === PRE_ELEMENT && this.preDepth > 0) this.preDepth--;
  }
}

/**
 * The title, text and parts of an HTML source, or `not-utf8` when its
 * bytes are not UTF-8. `offsetBase` is the number of file bytes that
 * precede `bytes` (a leading frontmatter block left out), so each part's
 * `sourceOffset` stays an offset in the source file. Pure: no I/O, no
 * clock, the same bytes give the same answer.
 */
export function extractHtml(bytes: Uint8Array, offsetBase = 0): HtmlExtractResult {
  let source: string;
  try {
    source = STRICT_UTF8.decode(bytes);
  } catch {
    return { extracted: false, reason: SOURCE_EXTRACT_SKIP_REASON.notUtf8 };
  }
  return new HtmlScanner(source, offsetBase).run();
}

/**
 * One line of the parts list: `h<level> <trail> | lines <a>-<b>`, or
 * `preamble | lines <a>-<b>`. A `\` in the trail is escaped as `\\` and
 * then a `|` as `\|`, as table cells are, so a heading cannot forge the
 * span that follows it, not even with a backslash of its own.
 */
export function formatPartLine(part: HtmlPart): string {
  const label =
    part.level === PREAMBLE_LEVEL
      ? PREAMBLE_LABEL
      : `h${part.level} ${part.trail
          .replaceAll(ESCAPE_CHAR, ESCAPED_ESCAPE_CHAR)
          .replaceAll(SPAN_SEPARATOR, ESCAPED_SPAN_SEPARATOR)}`;
  return `${label} ${SPAN_SEPARATOR} lines ${part.lineStart}-${part.lineEnd}`;
}

/**
 * The `## Parts` section of a summary page: the heading, a blank line and
 * one fenced block (info string `parts`) with one line per part. Inside
 * the fence a `[[link]]` or `#tag` in an untrusted heading stays out of
 * the link graph while full-text search still reads it. Empty when the
 * extraction has no parts.
 */
export function renderPartsSection(extraction: HtmlExtraction): string {
  if (extraction.parts.length === 0) return "";
  const body = extraction.parts.map(formatPartLine).join(LINE_FEED);
  const fence = fenceFor(body);
  return [PARTS_SECTION_HEADING, "", `${fence}${PARTS_FENCE_INFO}`, body, fence].join(LINE_FEED);
}
