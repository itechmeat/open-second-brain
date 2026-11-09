/**
 * Line-level edit of one key of `Brain/_brain.yaml` for an unswitched
 * machine (the legacy half of `./settings-write.ts`).
 *
 * Only the lines of the edited key change: comments, blank lines, key
 * order and every other value stay byte for byte, the way
 * `../set-primary.ts` edits `primary_agent`. The value domain is the one
 * the `_brain.yaml` parser reads (`../yaml-parse.ts`): a scalar, or a list
 * of scalars under a block field. The caller re-parses the result and
 * checks that it reads back as the value it asked for, so an edit this
 * module cannot represent is refused instead of written wrong.
 */

/** Marker for "remove this key". */
export const REMOVE_KEY: unique symbol = Symbol("remove");

export type YamlScalar = string | number | boolean | null;
export type YamlSettingValue = YamlScalar | ReadonlyArray<YamlScalar>;

/** A value the line editor cannot write so that the parser reads it back. */
export class UnrepresentableValueError extends Error {}

const DEFAULT_CHILD_INDENT = 2;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** One scalar as the parser reads it: quoted strings, bare everything else. */
export function renderYamlScalar(value: YamlScalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnrepresentableValueError("numbers must be finite");
    return String(value);
  }
  if (/[\r\n]/.test(value)) {
    throw new UnrepresentableValueError("a string value must be a single line");
  }
  // The parser strips one pair of quotes and reads no escapes.
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new UnrepresentableValueError("a string with both quote characters cannot be written");
}

function renderField(field: string, value: YamlSettingValue, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (!Array.isArray(value)) return [`${pad}${field}: ${renderYamlScalar(value as YamlScalar)}`];
  if (value.length === 0) return [`${pad}${field}: []`];
  return [
    `${pad}${field}:`,
    ...value.map((item) => `${pad}${" ".repeat(DEFAULT_CHILD_INDENT)}- ${renderYamlScalar(item)}`),
  ];
}

function keyRe(key: string): RegExp {
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\s|$)`);
}

/** Index range `[start, end)` of the lines a top-level block owns, header included. */
function blockRange(lines: ReadonlyArray<string>, block: string): [number, number] | null {
  const re = new RegExp(`^${block}:\\s*(#.*)?$`);
  const start = lines.findIndex((line) => indentOf(line) === 0 && re.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() !== "" && indentOf(line) === 0) break;
    end++;
  }
  // Trailing blank lines belong to the gap before the next key.
  while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
  return [start, end];
}

function editTopLevel(lines: string[], key: string, value: YamlSettingValue | typeof REMOVE_KEY) {
  const re = keyRe(key);
  const at = lines.findIndex((line) => indentOf(line) === 0 && re.test(line));
  if (value === REMOVE_KEY) {
    if (at !== -1) lines.splice(at, 1);
    return;
  }
  if (Array.isArray(value)) throw new UnrepresentableValueError(`${key} takes a single value`);
  const line = `${key}: ${renderYamlScalar(value as YamlScalar)}`;
  if (at !== -1) lines[at] = line;
  else insertAtEnd(lines, [line]);
}

function insertAtEnd(lines: string[], added: ReadonlyArray<string>): void {
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  if (lines.length > 0) lines.push("");
  lines.push(...added);
}

function editField(
  lines: string[],
  block: string,
  field: string,
  value: YamlSettingValue | typeof REMOVE_KEY,
): void {
  const range = blockRange(lines, block);
  if (range === null) {
    if (value === REMOVE_KEY) return;
    insertAtEnd(lines, [`${block}:`, ...renderField(field, value, DEFAULT_CHILD_INDENT)]);
    return;
  }
  const [start, end] = range;
  const firstChild = lines.slice(start + 1, end).find((line) => !isBlankOrComment(line));
  const childIndent = firstChild !== undefined ? indentOf(firstChild) : DEFAULT_CHILD_INDENT;
  const re = keyRe(field);
  let at = -1;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    if (indentOf(line) === childIndent && re.test(line.trimStart())) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    if (value === REMOVE_KEY) return;
    lines.splice(end, 0, ...renderField(field, value, childIndent));
    return;
  }
  let last = at + 1;
  while (last < end && lines[last]!.trim() !== "" && indentOf(lines[last]!) > childIndent) last++;
  const replacement = value === REMOVE_KEY ? [] : renderField(field, value, childIndent);
  lines.splice(at, last - at, ...replacement);
}

/**
 * `text` with `block` (a scalar top-level key) or `block.field` set to
 * `value`, or removed for {@link REMOVE_KEY}. Line endings are kept.
 */
export function editBrainYamlKey(
  text: string,
  block: string,
  field: string | undefined,
  value: YamlSettingValue | typeof REMOVE_KEY,
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length > 0 && lines.at(-1) === "";
  if (trailingNewline) lines.pop();
  if (field === undefined) editTopLevel(lines, block, value);
  else editField(lines, block, field, value);
  return lines.join(eol) + (trailingNewline || lines.length > 0 ? eol : "");
}
