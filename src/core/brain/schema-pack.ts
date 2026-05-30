import { existsSync, readFileSync } from "node:fs";

import { brainConfigPath } from "./paths.ts";
import {
  SCHEMA_VOCAB_CATEGORIES,
  resolveSchemaVocabulary,
  validateSchemaDeclarations,
  validateSchemaToken,
  type BrainSchemaDeclarations,
  type BrainSchemaVocabulary,
  type SchemaVocabularyCategory,
} from "./schema-vocab.ts";

export interface SchemaPack {
  readonly declarations: BrainSchemaDeclarations;
  readonly vocabulary: BrainSchemaVocabulary;
  readonly aliases: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly prefixes: Readonly<Record<string, string>>;
  readonly link_types: ReadonlyArray<string>;
  readonly extractable: ReadonlyArray<string>;
  readonly expert_routing: Readonly<Record<string, string>>;
}

export function loadSchemaPack(vault: string): SchemaPack {
  const path = brainConfigPath(vault);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "schema_version: 1\n";
  return parseSchemaPack(text);
}

export function parseSchemaPack(configText: string): SchemaPack {
  const lines = extractSchemaLines(configText);
  const partial: Partial<Record<SchemaVocabularyCategory, ReadonlyArray<string>>> = {};
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    const values = parseListField(lines, category);
    if (values.length > 0) partial[category] = values;
  }
  const declarations = validateSchemaDeclarations(partial);
  const aliases = parseMapListField(lines, "aliases", "schema.aliases");
  const prefixes = parseMapScalarField(lines, "prefixes", "schema.prefixes");
  const linkTypes = parseListField(lines, "link_types").map((token, index) =>
    validateSchemaToken(token, `schema.link_types[${index}]`),
  );
  const extractable = parseListField(lines, "extractable").map((token, index) =>
    validateSchemaToken(token, `schema.extractable[${index}]`),
  );
  const expertRouting = parseMapScalarField(
    lines,
    "expert_routing",
    "schema.expert_routing",
    false,
  );

  return freezeSchemaPack({
    declarations,
    vocabulary: resolveSchemaVocabulary(declarations),
    aliases,
    prefixes,
    link_types: unique(linkTypes),
    extractable: unique(extractable),
    expert_routing: expertRouting,
  });
}

export function renderSchemaBlock(pack: SchemaPack): string {
  const lines = ["schema:"];
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    const values = pack.declarations[category] ?? [];
    if (values.length === 0) continue;
    lines.push(`  ${category}:`);
    for (const token of values) lines.push(`    - ${token}`);
  }
  renderMapList(lines, "aliases", pack.aliases);
  renderMapScalar(lines, "prefixes", pack.prefixes);
  renderList(lines, "link_types", pack.link_types);
  renderList(lines, "extractable", pack.extractable);
  renderMapScalar(lines, "expert_routing", pack.expert_routing);
  if (lines.length === 1) lines.push("  {}");
  return lines.join("\n") + "\n";
}

export function replaceSchemaBlock(configText: string, schemaBlock: string): string {
  const normalized = configText.endsWith("\n") ? configText : configText + "\n";
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => /^schema:\s*$/.test(line));
  if (start < 0) return normalized + schemaBlock;

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) break;
    end++;
  }
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n").replace(/^\n+/, "");
  return [before, schemaBlock.trimEnd(), after].filter((part) => part.length > 0).join("\n") + "\n";
}

export function schemaPackTokens(pack: SchemaPack): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    for (const token of pack.vocabulary[category]) tokens.add(token);
  }
  for (const token of pack.link_types) tokens.add(token);
  return tokens;
}

function extractSchemaLines(configText: string): string[] {
  const all = configText.split(/\r?\n/);
  const start = all.findIndex((line) => /^schema:\s*$/.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (let index = start + 1; index < all.length; index++) {
    const line = all[index]!;
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) break;
    out.push(line);
  }
  return out;
}

function parseListField(lines: ReadonlyArray<string>, key: string): string[] {
  const start = findField(lines, key);
  if (start < 0) return [];
  const rest = fieldRest(lines[start]!, key);
  if (rest.startsWith("[")) return parseInlineList(rest);
  if (rest === "{}") return [];

  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^  \S/.test(line)) break;
    const match = /^    -\s+(.+?)\s*$/.exec(line);
    if (match) values.push(stripQuotes(match[1]!));
  }
  return values;
}

function parseMapListField(
  lines: ReadonlyArray<string>,
  key: string,
  field: string,
): Record<string, ReadonlyArray<string>> {
  const start = findField(lines, key);
  if (start < 0) return {};
  const out: Record<string, string[]> = {};
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^  \S/.test(line)) break;
    const flat = /^    -\s+(.+?)\s*$/.exec(line);
    if (flat) {
      const [rawToken, rawAlias] = splitPair(flat[1]!);
      const token = validateSchemaToken(rawToken, `${field}.${rawToken}`);
      const alias = validateSchemaToken(rawAlias, `${field}.${token}`);
      out[token] = out[token] ?? [];
      out[token]!.push(alias);
      continue;
    }
    const entry = /^    ([^:]+):\s*(.*)$/.exec(line);
    if (!entry) continue;
    const token = validateSchemaToken(stripQuotes(entry[1]!), `${field}.${entry[1]}`);
    const rest = entry[2]!.trim();
    const values = rest.startsWith("[") ? parseInlineList(rest) : collectNestedList(lines, index);
    out[token] = unique(
      values.map((value, valueIndex) =>
        validateSchemaToken(value, `${field}.${token}[${valueIndex}]`),
      ),
    );
  }
  return freezeRecord(out);
}

function parseMapScalarField(
  lines: ReadonlyArray<string>,
  key: string,
  field: string,
  validateValue = true,
): Record<string, string> {
  const start = findField(lines, key);
  if (start < 0) return {};
  const out: Record<string, string> = {};
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^  \S/.test(line)) break;
    const flat = /^    -\s+(.+?)\s*$/.exec(line);
    if (flat) {
      const [rawName, rawValue] = splitPair(flat[1]!);
      const name = validateSchemaToken(rawName, `${field}.${rawName}`);
      out[name] = validateValue
        ? validateSchemaToken(rawValue, `${field}.${name}`)
        : rawValue.trim();
      continue;
    }
    const entry = /^    ([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!entry) continue;
    const name = validateSchemaToken(stripQuotes(entry[1]!), `${field}.${entry[1]}`);
    const rawValue = stripQuotes(entry[2]!);
    out[name] = validateValue ? validateSchemaToken(rawValue, `${field}.${name}`) : rawValue.trim();
  }
  return freezeRecord(out);
}

function collectNestedList(lines: ReadonlyArray<string>, start: number): string[] {
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^    \S/.test(line) || /^  \S/.test(line)) break;
    const match = /^      -\s+(.+?)\s*$/.exec(line);
    if (match) values.push(stripQuotes(match[1]!));
  }
  return values;
}

function findField(lines: ReadonlyArray<string>, key: string): number {
  return lines.findIndex((line) => new RegExp(`^  ${escapeRegex(key)}:\\s*`).test(line));
}

function fieldRest(line: string, key: string): string {
  return line.replace(new RegExp(`^  ${escapeRegex(key)}:\\s*`), "").trim();
}

function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((item) => stripQuotes(item));
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function renderList(lines: string[], key: string, values: ReadonlyArray<string>): void {
  if (values.length === 0) return;
  lines.push(`  ${key}:`);
  for (const value of values) lines.push(`    - ${value}`);
}

function renderMapList(
  lines: string[],
  key: string,
  values: Readonly<Record<string, ReadonlyArray<string>>>,
): void {
  const entries = Object.entries(values).toSorted(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return;
  lines.push(`  ${key}:`);
  for (const [token, aliases] of entries) {
    for (const alias of aliases) lines.push(`    - ${token}=${alias}`);
  }
}

function renderMapScalar(
  lines: string[],
  key: string,
  values: Readonly<Record<string, string>>,
): void {
  const entries = Object.entries(values).toSorted(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return;
  lines.push(`  ${key}:`);
  for (const [name, value] of entries) lines.push(`    - ${name}=${value}`);
}

function splitPair(raw: string): [string, string] {
  const index = raw.indexOf("=");
  if (index < 0) return [raw, ""];
  return [raw.slice(0, index).trim(), raw.slice(index + 1).trim()];
}

function freezeSchemaPack(
  input: Omit<SchemaPack, "vocabulary"> & { vocabulary: BrainSchemaVocabulary },
): SchemaPack {
  return Object.freeze({
    declarations: input.declarations,
    vocabulary: input.vocabulary,
    aliases: input.aliases,
    prefixes: input.prefixes,
    link_types: Object.freeze([...input.link_types]),
    extractable: Object.freeze([...input.extractable]),
    expert_routing: input.expert_routing,
  });
}

function freezeRecord<T>(record: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze({ ...record });
}

function unique(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
