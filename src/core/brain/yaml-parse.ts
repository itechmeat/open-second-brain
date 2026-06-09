/**
 * Minimal indent-aware parser for the YAML subset used by `_brain.yaml`.
 *
 * Extracted from policy.ts so config semantics (validation, defaults,
 * resolvers) and syntax parsing live in separate modules. The grammar
 * is unchanged.
 */

// The parser handles only the shape used by `_brain.yaml`:
//
//   - `# comment` lines and blanks
//   - top-level `key: <scalar>`
//   - top-level `key:` followed by an indented block of one indent level
//   - block-level `<indent>key: <scalar>`
//
// Scalars are parsed as:
//   - plain integers / floats (no exponents, no leading +)
//   - quoted strings ('..' or "..") — the quotes are stripped and the
//     content is taken as-is (no escape sequences)
//   - the bare words `true`, `false`, `null`
//   - otherwise: the literal string
//
// This intentionally rejects nested mappings deeper than two levels,
// anchors, and aliases — none of which the schema needs.

export type ParsedScalar = number | string | boolean | null;
type ParsedBlockValue =
  | ParsedScalar
  | Record<string, ParsedScalar | ParsedScalar[]>
  | ParsedScalar[];
export type ParsedBlock = Record<string, ParsedBlockValue>;

interface Line {
  readonly raw: string;
  readonly indent: number;
  readonly content: string;
  readonly lineNumber: number;
}

export function parseBrainYaml(text: string): ParsedBlock {
  const lines = splitLines(text);
  const out: ParsedBlock = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent !== 0) {
      throw new Error(`line ${line.lineNumber}: unexpected indentation at top level`);
    }
    const kv = splitKeyValue(line);
    if (kv.value === "") {
      // Block header: collect indented children.
      // Each child may be a scalar value (`key: val`) or a list (`key:` followed
      // by deeper-indented `- item` lines). Lists-within-blocks are the only
      // third-level nesting we support — they are required for `discipline_report`.
      const child: Record<string, ParsedScalar | ParsedScalar[]> = {};
      i++;
      const blockIndent = detectBlockIndent(lines, i);
      while (i < lines.length && lines[i]!.indent >= blockIndent && blockIndent > 0) {
        const inner = lines[i]!;
        if (inner.indent !== blockIndent) {
          throw new Error(
            `line ${inner.lineNumber}: inconsistent indentation in block '${kv.key}' ` +
              `(expected ${blockIndent} spaces, got ${inner.indent})`,
          );
        }
        const innerKv = splitKeyValue(inner);
        if (innerKv.value === "") {
          // Child key with no value — expect a list of `- item` lines at a
          // deeper indent level.
          i++;
          const listIndent = detectBlockIndent(lines, i);
          if (listIndent <= blockIndent) {
            // Empty list (next line is at the same or shallower indent).
            if (innerKv.key in child) {
              throw new Error(
                `line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`,
              );
            }
            child[innerKv.key] = [];
            continue;
          }
          const items: ParsedScalar[] = [];
          while (i < lines.length && lines[i]!.indent >= listIndent) {
            const listLine = lines[i]!;
            if (listLine.indent !== listIndent) {
              throw new Error(
                `line ${listLine.lineNumber}: inconsistent indentation in list '${innerKv.key}' ` +
                  `(expected ${listIndent} spaces, got ${listLine.indent})`,
              );
            }
            if (!listLine.content.startsWith("- ") && listLine.content !== "-") {
              // If it looks like a `key: value` pair, it's a deeper block — not
              // supported. Preserve the original error message so existing tests
              // that assert on the wording keep passing.
              if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(listLine.content)) {
                throw new Error(
                  `line ${listLine.lineNumber}: nested blocks deeper than one level are not supported`,
                );
              }
              throw new Error(
                `line ${listLine.lineNumber}: expected list item starting with '- ' ` +
                  `in '${kv.key}.${innerKv.key}'`,
              );
            }
            const itemText = listLine.content.startsWith("- ")
              ? listLine.content.slice(2).trim()
              : "";
            const item = parseScalar(itemText, listLine.lineNumber);
            if (Array.isArray(item)) {
              throw new Error(
                `line ${listLine.lineNumber}: nested inline arrays are not supported`,
              );
            }
            items.push(item);
            i++;
          }
          if (innerKv.key in child) {
            throw new Error(
              `line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`,
            );
          }
          child[innerKv.key] = items;
          continue;
        }
        if (innerKv.key in child) {
          throw new Error(
            `line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`,
          );
        }
        child[innerKv.key] = parseScalar(innerKv.value, inner.lineNumber);
        i++;
      }
      if (kv.key in out) {
        throw new Error(`duplicate top-level key '${kv.key}'`);
      }
      out[kv.key] = child;
      continue;
    }
    if (kv.key in out) {
      throw new Error(`duplicate top-level key '${kv.key}'`);
    }
    out[kv.key] = parseScalar(kv.value, line.lineNumber);
    i++;
  }
  return out;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber++;
    // Strip trailing whitespace; leave leading intact for indent detection.
    const stripped = raw.replace(/\s+$/, "");
    // Skip blanks and comment-only lines.
    if (stripped.trim() === "") continue;
    if (stripped.trimStart().startsWith("#")) continue;
    // Strip inline comments only when they are clearly outside a quoted
    // value. Keep this simple: only honour ` #` (space then hash) on
    // unquoted lines. Quoted values keep their content verbatim.
    let content = stripped;
    if (!/['"]/.test(stripped)) {
      const hashIdx = stripped.indexOf(" #");
      if (hashIdx >= 0) content = stripped.slice(0, hashIdx).replace(/\s+$/, "");
    }
    const indent = content.length - content.trimStart().length;
    out.push({
      raw,
      indent,
      content: content.slice(indent),
      lineNumber,
    });
  }
  return out;
}

interface KeyValue {
  readonly key: string;
  readonly value: string;
}

function splitKeyValue(line: Line): KeyValue {
  const idx = line.content.indexOf(":");
  if (idx <= 0) {
    throw new Error(
      `line ${line.lineNumber}: expected 'key: value', got: ${JSON.stringify(line.raw)}`,
    );
  }
  const key = line.content.slice(0, idx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error(`line ${line.lineNumber}: invalid key name: ${JSON.stringify(key)}`);
  }
  const value = line.content.slice(idx + 1).trim();
  return { key, value };
}

function detectBlockIndent(lines: Line[], cursor: number): number {
  if (cursor >= lines.length) return 0;
  const first = lines[cursor]!;
  if (first.indent === 0) return 0; // empty block (next top-level key)
  return first.indent;
}

function parseScalar(text: string, lineNumber: number): ParsedScalar | ParsedScalar[] {
  if (text.startsWith("[") && text.endsWith("]")) {
    return parseInlineArray(text.slice(1, -1), lineNumber);
  }
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  // Number: integer or finite decimal. Anything else → literal string.
  if (/^-?\d+$/.test(text)) {
    const n = parseInt(text, 10);
    return n;
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    const n = parseFloat(text);
    if (!Number.isFinite(n)) {
      throw new Error(`line ${lineNumber}: non-finite number: ${text}`);
    }
    return n;
  }
  return text;
}

function parseInlineArray(innerRaw: string, lineNumber: number): ParsedScalar[] {
  const inner = innerRaw.trim();
  if (inner === "") return [];

  const out: ParsedScalar[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar: '"' | "'" | "" = "";

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inQuote) {
      current += ch;
      if (ch === quoteChar) {
        inQuote = false;
        quoteChar = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      out.push(parseInlineArrayItem(current, lineNumber));
      current = "";
      continue;
    }
    current += ch;
  }
  if (inQuote) {
    throw new Error(`line ${lineNumber}: unterminated quoted string in inline array`);
  }
  out.push(parseInlineArrayItem(current, lineNumber));
  return out;
}

function parseInlineArrayItem(text: string, lineNumber: number): ParsedScalar {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error(`line ${lineNumber}: empty item in inline array`);
  }
  const parsed = parseScalar(trimmed, lineNumber);
  if (Array.isArray(parsed)) {
    throw new Error(`line ${lineNumber}: nested inline arrays are not supported`);
  }
  return parsed;
}
