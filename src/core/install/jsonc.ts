/**
 * Minimal vendored JSONC editor for runtime config files.
 *
 * The repo has exactly one runtime dependency, and the OpenCode V2 config
 * surface needs a narrow slice of JSONC editing: locate a nested key in a
 * document that may carry `//` and `/* * /` comments or trailing commas,
 * splice one entry in, over or out, and keep every byte outside the
 * spliced range - operator comments included - exactly as it was. A
 * dependency would be the larger, less honest change for this surface,
 * so this is the vendored minimum: a tokenizer, a structural parse and
 * token-offset splices. Whole-root re-serialization is exactly what this
 * module must never do; `json-merge.ts` remains the write path for
 * comment-free files, where its JSON-value-level round-trip already
 * holds.
 *
 * Contract:
 *   - Pure text-in/text-out. No fs, no clock, no imports.
 *   - A leading UTF-8 BOM is stripped on read and restored on write, the
 *     same tolerance json-merge applies for Windows-side editors.
 *   - `hasJsoncSyntax` is lexical and total: it answers whether the text
 *     carries comments or trailing commas even when the text is
 *     otherwise malformed, because callers route on it before parsing.
 *   - Malformed input, duplicate keys (anywhere - an ambiguous document
 *     is refused, not interpreted) and a non-object root raise the named
 *     `JsoncEditError`. No partial text is ever emitted.
 *   - Object keys materialize as own properties: a literal `__proto__`
 *     key is data, never the parsed object's prototype - the same
 *     literal-key semantics JSON.parse gives it. Assigning through the
 *     inherited accessor would let a crafted config forge membership
 *     and bracket reads for every downstream `in`-based check.
 *   - Inserted values must be JSON-serializable; comments cannot be
 *     authored through this editor - it exists to PRESERVE operator
 *     comments, not to write them.
 *   - Formatting of inserted bytes: a multi-line object fills at the
 *     indentation of its neighbors (detected unit, 2 as fallback); an
 *     object that occupies a single line stays single-line and is filled
 *     compactly. Untouched bytes are never reformatted.
 */

/** The named refusal for malformed, ambiguous or uneditable JSONC. */
export class JsoncEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsoncEditError";
  }
}

const BOM = "\uFEFF";
const DEFAULT_INDENT_UNIT = 2;

// ----- Tokenizer -------------------------------------------------------------

type TokenKind = "punct" | "string" | "number" | "literal";

interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  /** Offset just past the token. */
  readonly end: number;
  /** Punctuation character, decoded string value, or raw text. */
  readonly text: string;
}

interface Lex {
  readonly tokens: ReadonlyArray<Token>;
  readonly hasComments: boolean;
  readonly hasTrailingCommas: boolean;
  /** The first scanning failure, when the text is not tokenizable. */
  readonly error: string | null;
}

const PUNCTUATION = new Set(["{", "}", "[", "]", ":", ","]);
const STRING_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/** The end offset (exclusive) of the string opening at `open`, or the reason it cannot be scanned. */
function scanString(body: string, open: number): number | string {
  let i = open + 1;
  while (i < body.length) {
    const c = body[i]!;
    if (c === '"') return i + 1;
    if (c === "\\") {
      const esc = body[i + 1];
      if (esc === undefined) return `unterminated escape in string at offset ${i}`;
      if (esc === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(body.slice(i + 2, i + 6))) {
          return `invalid unicode escape in string at offset ${i}`;
        }
        i += 6;
        continue;
      }
      if (!STRING_ESCAPES.has(esc)) return `invalid escape in string at offset ${i}`;
      i += 2;
      continue;
    }
    if (c.charCodeAt(0) < 0x20) return `unescaped control character in string at offset ${i}`;
    i++;
  }
  return `unterminated string at offset ${open}`;
}

function scan(body: string): Lex {
  const tokens: Token[] = [];
  let hasComments = false;
  let error: string | null = null;
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (isWhitespace(c)) {
      i += 1;
      continue;
    }
    if (c === "/") {
      const next = body[i + 1];
      if (next === "/") {
        hasComments = true;
        const nl = body.indexOf("\n", i);
        i = nl === -1 ? body.length : nl;
        continue;
      }
      if (next === "*") {
        const close = body.indexOf("*/", i + 2);
        if (close === -1) {
          error = `unterminated block comment at offset ${i}`;
          break;
        }
        hasComments = true;
        i = close + 2;
        continue;
      }
      error = `unexpected character "/" at offset ${i}`;
      break;
    }
    if (c === '"') {
      const end = scanString(body, i);
      if (typeof end === "string") {
        error = end;
        break;
      }
      let decoded: string;
      try {
        decoded = JSON.parse(body.slice(i, end)) as string;
      } catch {
        error = `invalid string at offset ${i}`;
        break;
      }
      tokens.push({ kind: "string", start: i, end, text: decoded });
      i = end;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      // The full remaining body, not a window: the anchored regex stops
      // at the literal's own end, and a window shorter than a (valid,
      // exotic) literal would split it into two number tokens and
      // false-refuse the document as malformed.
      const match = NUMBER_RE.exec(body.slice(i));
      if (match === null) {
        error = `invalid number at offset ${i}`;
        break;
      }
      tokens.push({ kind: "number", start: i, end: i + match[0].length, text: match[0] });
      i += match[0].length;
      continue;
    }
    let literal: string | null = null;
    for (const candidate of ["true", "false", "null"]) {
      if (body.startsWith(candidate, i)) {
        literal = candidate;
        break;
      }
    }
    if (literal !== null) {
      tokens.push({ kind: "literal", start: i, end: i + literal.length, text: literal });
      i += literal.length;
      continue;
    }
    if (PUNCTUATION.has(c)) {
      tokens.push({ kind: "punct", start: i, end: i + 1, text: c });
      i += 1;
      continue;
    }
    error = `unexpected character ${JSON.stringify(c)} at offset ${i}`;
    break;
  }
  let hasTrailingCommas = false;
  for (let k = 0; k + 1 < tokens.length; k++) {
    const comma = tokens[k]!;
    const after = tokens[k + 1]!;
    if (comma.kind === "punct" && comma.text === "," && after.kind === "punct") {
      if (after.text === "}" || after.text === "]") hasTrailingCommas = true;
    }
  }
  return { tokens, hasComments, hasTrailingCommas, error };
}

// ----- Structural parse ------------------------------------------------------

interface ObjectEntry {
  readonly key: string;
  /** Offset of the opening quote of the key. */
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly value: Node;
}

interface ObjectNode {
  readonly kind: "object";
  readonly start: number;
  readonly end: number;
  readonly openBrace: number;
  readonly closeBrace: number;
  readonly entries: ReadonlyMap<string, ObjectEntry>;
  readonly order: ReadonlyArray<ObjectEntry>;
}

interface ArrayNode {
  readonly kind: "array";
  readonly start: number;
  readonly end: number;
  readonly elements: ReadonlyArray<Node>;
}

interface LeafNode {
  readonly kind: "leaf";
  readonly start: number;
  readonly end: number;
  readonly value: unknown;
}

type Node = ObjectNode | ArrayNode | LeafNode;

interface TokenReader {
  readonly tokens: ReadonlyArray<Token>;
  pos: number;
}

function peek(reader: TokenReader): Token | null {
  return reader.pos < reader.tokens.length ? reader.tokens[reader.pos]! : null;
}

function take(reader: TokenReader): Token {
  const token = peek(reader);
  if (token === null) throw new JsoncEditError("unexpected end of document");
  reader.pos += 1;
  return token;
}

function takePunct(reader: TokenReader, char: string): Token {
  const token = take(reader);
  if (token.kind !== "punct" || token.text !== char) {
    throw new JsoncEditError(`expected "${char}" at offset ${token.start}`);
  }
  return token;
}

function parseValue(reader: TokenReader): Node {
  const token = peek(reader);
  if (token === null) throw new JsoncEditError("expected a value, found end of document");
  if (token.kind === "punct") {
    // A value position accepts only the two container openings. Any
    // other punctuation - the `:` or `,` of a half-edited document
    // (`{"a": ,}`, `[,]`) - is malformed input, not a null: reading it
    // as one would let apply proceed on a file no JSON parser accepts.
    if (token.text !== "{" && token.text !== "[") {
      throw new JsoncEditError(`expected a value, found "${token.text}" at offset ${token.start}`);
    }
    return token.text === "{" ? parseObject(reader) : parseArray(reader);
  }
  take(reader);
  if (token.kind === "string") {
    return { kind: "leaf", start: token.start, end: token.end, value: token.text };
  }
  if (token.kind === "number") {
    return { kind: "leaf", start: token.start, end: token.end, value: Number(token.text) };
  }
  const value = token.text === "true" ? true : token.text === "false" ? false : null;
  return { kind: "leaf", start: token.start, end: token.end, value };
}

function parseObject(reader: TokenReader): ObjectNode {
  const open = takePunct(reader, "{");
  const entries = new Map<string, ObjectEntry>();
  const order: ObjectEntry[] = [];
  let close = peek(reader);
  if (close !== null && close.kind === "punct" && close.text === "}") {
    take(reader);
    return {
      kind: "object",
      start: open.start,
      end: close.end,
      openBrace: open.start,
      closeBrace: close.start,
      entries,
      order,
    };
  }
  for (;;) {
    const key = take(reader);
    if (key.kind !== "string") {
      throw new JsoncEditError(`expected a string object key at offset ${key.start}`);
    }
    takePunct(reader, ":");
    const value = parseValue(reader);
    if (entries.has(key.text)) {
      throw new JsoncEditError(`duplicate key "${key.text}" at offset ${key.start}`);
    }
    const entry: ObjectEntry = {
      key: key.text,
      keyStart: key.start,
      valueStart: value.start,
      valueEnd: value.end,
      value,
    };
    entries.set(key.text, entry);
    order.push(entry);
    const separator = peek(reader);
    if (separator !== null && separator.kind === "punct" && separator.text === ",") {
      take(reader);
      const after = peek(reader);
      if (after !== null && after.kind === "punct" && after.text === "}") {
        take(reader);
        close = after;
        break;
      }
      continue;
    }
    const closing = takePunct(reader, "}");
    close = closing;
    break;
  }
  return {
    kind: "object",
    start: open.start,
    end: close!.end,
    openBrace: open.start,
    closeBrace: close!.start,
    entries,
    order,
  };
}

function parseArray(reader: TokenReader): ArrayNode {
  const open = takePunct(reader, "[");
  const elements: Node[] = [];
  let close = peek(reader);
  if (close !== null && close.kind === "punct" && close.text === "]") {
    take(reader);
    return { kind: "array", start: open.start, end: close.end, elements };
  }
  for (;;) {
    elements.push(parseValue(reader));
    const separator = peek(reader);
    if (separator !== null && separator.kind === "punct" && separator.text === ",") {
      take(reader);
      const after = peek(reader);
      if (after !== null && after.kind === "punct" && after.text === "]") {
        take(reader);
        close = after;
        break;
      }
      continue;
    }
    close = takePunct(reader, "]");
    break;
  }
  return { kind: "array", start: open.start, end: close!.end, elements };
}

function parseRoot(lex: Lex): ObjectNode {
  if (lex.error !== null) throw new JsoncEditError(lex.error);
  const reader: TokenReader = { tokens: lex.tokens, pos: 0 };
  const root = parseValue(reader);
  const trailing = peek(reader);
  if (trailing !== null) {
    throw new JsoncEditError(`unexpected content after the root value at offset ${trailing.start}`);
  }
  if (root.kind !== "object") throw new JsoncEditError("expected a JSON object at the root");
  return root;
}

// ----- Text helpers ------------------------------------------------------------

function stripBom(text: string): { body: string; hadBom: boolean } {
  return text.charCodeAt(0) === 0xfeff
    ? { body: text.slice(1), hadBom: true }
    : { body: text, hadBom: false };
}

function restoreBom(text: string, hadBom: boolean): string {
  return hadBom ? BOM + text : text;
}

function isSpaceOrTab(c: string): boolean {
  return c === " " || c === "\t";
}

/**
 * Horizontal whitespace a separator scan may cross: a CRLF file's
 * carriage returns sit between a separator comma and the entry that
 * follows it, so a walk-back that stopped at `\r` would miss the comma
 * entirely.
 */
function isHorizontalWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\r";
}

/** Characters that can begin a JSON token; anything else opens a comment. */
const TOKEN_START = /["{}[],:0-9tfn-]/;

/**
 * Width of the first space-indented line that starts with a token, the
 * unit `json-merge` detects too; 2 as fallback. A line whose first
 * non-space byte opens a comment carries the author's prose layout, not
 * the file's indentation step - a leading block comment must not shrink
 * the unit to its own star's column.
 */
function indentUnit(text: string): number {
  for (const line of text.split("\n")) {
    const match = /^( +)(.)/.exec(line);
    if (match === null) continue;
    if (TOKEN_START.test(match[2]!)) return match[1]!.length;
  }
  return DEFAULT_INDENT_UNIT;
}

/** Leading whitespace of the line containing `offset` (callers pass offsets at line starts). */
function lineIndent(text: string, offset: number): string {
  const lineStart = offset > 0 ? text.lastIndexOf("\n", offset - 1) + 1 : 0;
  let end = lineStart;
  while (end < text.length && isSpaceOrTab(text[end]!)) end += 1;
  return text.slice(lineStart, end);
}

function splice(text: string, start: number, end: number, inserted: string): string {
  return text.slice(0, start) + inserted + text.slice(end);
}

/**
 * The value as inserted bytes: pretty-printed at the detected unit and
 * re-indented under the entry's key. Scalars stay on the key's line.
 */
function renderValue(value: unknown, unit: number, keyIndent: string): string {
  const rendered = JSON.stringify(value, null, unit);
  if (rendered === undefined) {
    throw new JsoncEditError("value is not JSON-serializable");
  }
  return unit === 0 ? rendered : rendered.replace(/\n/g, "\n" + keyIndent);
}

// ----- Entry insertion, replacement and removal ---------------------------------

/**
 * Where the last entry's line ends, and whether a separator comma sits
 * on it. The splice point for a new entry is past that line's newline,
 * so the entry's own trailing line comment stays annotating the entry
 * instead of moving to the inserted one. A block comment that starts on
 * the value's line and runs past its newline pushes the line end past
 * its close, so the new entry never lands inside the comment - and the
 * scan never crosses the object's closing brace. Comments never
 * tokenize, so a comma reached outside them is code by construction.
 */
function trailingLineOf(
  text: string,
  valueEnd: number,
  closeBrace: number,
): { lineEnd: number; separator: boolean } {
  const firstNewline = text.indexOf("\n", valueEnd);
  let lineEnd = firstNewline === -1 ? text.length : firstNewline;
  let separator = false;
  let i = valueEnd;
  while (i < lineEnd) {
    const c = text[i]!;
    if (isWhitespace(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") break; // the rest of the line is comment content
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const commentEnd = close === -1 ? Math.min(closeBrace, text.length) : close + 2;
      if (commentEnd > lineEnd) {
        const nl = text.indexOf("\n", commentEnd);
        lineEnd = Math.min(nl === -1 ? text.length : nl, closeBrace);
      }
      i = Math.min(commentEnd, text.length);
      continue;
    }
    if (c === ",") {
      separator = true;
      i += 1;
      continue;
    }
    break; // a code byte that is neither separator nor comment cannot follow a parsed value
  }
  return { lineEnd, separator };
}

/**
 * Splice one new entry at the end of `obj`. A single-line object stays
 * single-line (compact value); a multi-line object fills at its
 * neighbors' indentation. The new entry opens the line after the last
 * entry's own line: a separator comma is added at the old value end
 * only when the last entry does not already carry one, and any comment
 * sharing that line keeps its place.
 */
function insertEntry(text: string, obj: ObjectNode, key: string, value: unknown): string {
  const keyText = JSON.stringify(key);
  if (obj.order.length === 0) {
    const between = text.slice(obj.openBrace + 1, obj.closeBrace);
    if (!between.includes("\n")) {
      const rendered = JSON.stringify(value);
      if (rendered === undefined) throw new JsoncEditError("value is not JSON-serializable");
      return splice(text, obj.openBrace + 1, obj.openBrace + 1, keyText + ": " + rendered);
    }
    const childIndent = lineIndent(text, obj.closeBrace) + " ".repeat(indentUnit(text));
    return splice(
      text,
      obj.openBrace + 1,
      obj.openBrace + 1,
      "\n" + childIndent + keyText + ": " + renderValue(value, indentUnit(text), childIndent),
    );
  }
  const last = obj.order[obj.order.length - 1]!;
  const between = text.slice(last.valueEnd, obj.closeBrace);
  if (!between.includes("\n")) {
    const rendered = JSON.stringify(value);
    if (rendered === undefined) throw new JsoncEditError("value is not JSON-serializable");
    // A separator comma straight after the value (single-line
    // trailing-comma style) is not doubled: the entry slots in behind it.
    let i = last.valueEnd;
    while (i < text.length && isSpaceOrTab(text[i]!)) i += 1;
    if (text[i] === ",") {
      return splice(text, i + 1, i + 1, " " + keyText + ": " + rendered);
    }
    return splice(text, last.valueEnd, last.valueEnd, ", " + keyText + ": " + rendered);
  }
  const { lineEnd, separator } = trailingLineOf(text, last.valueEnd, obj.closeBrace);
  const keyIndent = lineIndent(text, last.keyStart);
  const entry = keyIndent + keyText + ": " + renderValue(value, indentUnit(text), keyIndent);
  // head keeps the value's line - separator and comment included - with
  // a comma added at the old value end only when there is none; the new
  // entry opens the following line, ahead of the untouched tail.
  const head =
    text.slice(0, last.valueEnd) + (separator ? "" : ",") + text.slice(last.valueEnd, lineEnd);
  return head + "\n" + entry + text.slice(lineEnd);
}

/**
 * Splice over exactly the existing entry's value range, leaving the key
 * and its line untouched. A value that occupies a single line is
 * replaced compactly: re-placing a compact entry with a pretty-printed
 * one would make every no-op re-apply rewrite bytes.
 */
function replaceEntry(text: string, entry: ObjectEntry, value: unknown): string {
  const rendered = text.slice(entry.valueStart, entry.valueEnd).includes("\n")
    ? renderValue(value, indentUnit(text), lineIndent(text, entry.keyStart))
    : JSON.stringify(value);
  if (rendered === undefined) {
    throw new JsoncEditError("value is not JSON-serializable");
  }
  return splice(text, entry.valueStart, entry.valueEnd, rendered);
}

/**
 * Whether the tokenizer emitted a comma at exactly `offset`. Comment
 * bytes never tokenize, so this is what separates a separator comma from
 * a `,` that merely closes an operator comment line.
 */
function isCommaTokenAt(tokens: ReadonlyArray<Token>, offset: number): boolean {
  for (const token of tokens) {
    if (token.start === offset) return token.kind === "punct" && token.text === ",";
    if (token.start > offset) return false;
  }
  return false;
}

/**
 * Splice out one entry, commas included, without touching a comment that
 * shares the line. When the entry is alone on its line(s) the whole line
 * collapses so no hole is left behind.
 */
function removeEntry(text: string, tokens: ReadonlyArray<Token>, entry: ObjectEntry): string {
  let start = entry.keyStart;
  let end = entry.valueEnd;
  let trailingComma = false;
  // The separator may sit at the head of a FOLLOWING line (comma-first
  // style), so the forward scan crosses newlines the way the walk-back
  // below does, and it steps over comment ranges: a trailing `// note`
  // sharing the entry's line hides the next line's leading comma, and a
  // comma reached past a comment is code - the comment's own bytes are
  // skipped by range, never scanned. Consuming that comma is what keeps
  // a comma-first document parseable once the entry (and its comment)
  // are gone.
  let j = end;
  for (;;) {
    while (j < text.length && isWhitespace(text[j]!)) j += 1;
    if (text[j] === "," && isCommaTokenAt(tokens, j)) {
      end = j + 1;
      trailingComma = true;
      break;
    }
    if (text[j] === "/" && text[j + 1] === "/") {
      const nl = text.indexOf("\n", j);
      if (nl === -1) break;
      j = nl + 1;
      continue;
    }
    if (text[j] === "/" && text[j + 1] === "*") {
      const close = text.indexOf("*/", j + 2);
      if (close === -1) break;
      j = close + 2;
      continue;
    }
    break;
  }
  if (!trailingComma) {
    let k = start;
    while (k > 0 && isHorizontalWs(text[k - 1]!)) k -= 1;
    if (k > 0 && text[k - 1] === ",") {
      start = k - 1;
    } else if (k > 0 && text[k - 1] === "\n") {
      // The separating comma may close the previous line instead
      // (`..., }\n  "ours": ...`); consuming it is what restores the
      // original bytes when the removed entry was last in its object.
      // A comment between the comma and the entry stops the walk-back,
      // and the leftover trailing comma stays - valid JSONC either way.
      // A comma that is the last byte of a COMMENT line is comment
      // content, not a separator: only a comma the tokenizer emitted
      // may be consumed, so the operator's bytes stay exactly as they
      // were.
      let m = k - 1;
      while (m > 0 && isHorizontalWs(text[m - 1]!)) m -= 1;
      if (m > 0 && text[m - 1] === "," && isCommaTokenAt(tokens, m - 1)) start = m - 1;
    }
  }
  const lineStart = start > 0 ? text.lastIndexOf("\n", start - 1) + 1 : 0;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline === -1 ? text.length : newline;
  const prefix = text.slice(lineStart, start);
  const suffix = text.slice(end, lineEnd);
  const aloneOnLine = [...prefix, ...suffix].every(isHorizontalWs);
  // Collapse the whole line(s) the entry occupies, its terminating
  // newline included, so no hole is left - the prefix already ends with
  // the previous line's newline.
  const collapseEnd = newline === -1 ? text.length : newline + 1;
  return aloneOnLine
    ? text.slice(0, lineStart) + text.slice(collapseEnd)
    : text.slice(0, start) + text.slice(end);
}

/** The literal for a missing intermediate object: the remaining path down to the entry. */
function nestedLiteral(remaining: ReadonlyArray<string>, key: string, value: unknown): unknown {
  let out: Record<string, unknown> = { [key]: value };
  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    out = { [remaining[i]!]: out };
  }
  return out;
}

function setInObject(
  text: string,
  root: ObjectNode,
  path: ReadonlyArray<string>,
  key: string,
  value: unknown,
): string {
  let current = root;
  for (let depth = 0; depth < path.length; depth += 1) {
    const segment = path[depth]!;
    const entry = current.entries.get(segment);
    if (entry === undefined) {
      return insertEntry(text, current, segment, nestedLiteral(path.slice(depth + 1), key, value));
    }
    if (entry.value.kind !== "object") {
      throw new JsoncEditError(`"${segment}" at offset ${entry.valueStart} is not a JSON object`);
    }
    current = entry.value;
  }
  const existing = current.entries.get(key);
  return existing === undefined
    ? insertEntry(text, current, key, value)
    : replaceEntry(text, existing, value);
}

function removeFromObject(
  text: string,
  tokens: ReadonlyArray<Token>,
  root: ObjectNode,
  path: ReadonlyArray<string>,
  key: string,
): string {
  let current = root;
  for (const segment of path) {
    const entry = current.entries.get(segment);
    if (entry === undefined || entry.value.kind !== "object") return text;
    current = entry.value;
  }
  const entry = current.entries.get(key);
  return entry === undefined ? text : removeEntry(text, tokens, entry);
}

// ----- Public surface -----------------------------------------------------------

/**
 * Whether the text carries JSON-only-rejected syntax: comments or
 * trailing commas. Lexical and total - a malformed document still gets
 * the flags found before the first scanning failure, because callers
 * route on this answer before any parse.
 */
export function hasJsoncSyntax(text: string): boolean {
  const { body } = stripBom(text);
  const lex = scan(body);
  return lex.hasComments || lex.hasTrailingCommas;
}

/**
 * Parse JSONC text into a plain object. Duplicate keys anywhere, a
 * non-object root and malformed input raise `JsoncEditError`.
 */
export function parseJsoncObject(text: string): Record<string, unknown> {
  const { body } = stripBom(text);
  return toPlainObject(parseRoot(scan(body)));
}

/**
 * An object node's entries as a plain record. Split from the general
 * value case so the object-root contract of `parseJsoncObject` is
 * satisfied by construction - the root is statically an ObjectNode, so
 * the record needs no cast and no runtime re-check.
 *
 * Each key is written as its own data property. The plain assignment
 * `out[key] = ...` routes a key named `__proto__` through the inherited
 * accessor and makes the crafted value the accumulator's prototype -
 * prototype injection. `defineProperty` keeps every key, that one
 * included, a real own property: the parse result matches what
 * JSON.parse hands out for the same document, and no downstream read
 * can see keys the file does not carry.
 */
function toPlainObject(node: ObjectNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of node.order) {
    Object.defineProperty(out, entry.key, {
      value: toPlainValue(entry.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function toPlainValue(node: Node): unknown {
  if (node.kind === "leaf") return node.value;
  if (node.kind === "array") return node.elements.map(toPlainValue);
  return toPlainObject(node);
}

/**
 * Insert or replace the entry `key` under the object at `path`, creating
 * missing intermediate objects, and return the new text. Every byte
 * outside the spliced range - comments and formatting included - is
 * preserved as it was.
 */
export function setJsoncEntry(
  text: string,
  path: ReadonlyArray<string>,
  key: string,
  value: unknown,
): string {
  const { body, hadBom } = stripBom(text);
  const next = setInObject(body, parseRoot(scan(body)), path, key, value);
  return restoreBom(next, hadBom);
}

/**
 * Remove the entry `key` from the object at `path` and return the new
 * text. An absent key or an absent path is a byte-identical no-op.
 */
export function removeJsoncEntry(text: string, path: ReadonlyArray<string>, key: string): string {
  const { body, hadBom } = stripBom(text);
  const lex = scan(body);
  const next = removeFromObject(body, lex.tokens, parseRoot(lex), path, key);
  return restoreBom(next, hadBom);
}
