/**
 * The permissions document: `<vault>/Brain/_permissions.yaml` (write-side-
 * trust, Task 1).
 *
 * Trust policy is state the operator hand-edits and syncs to every device,
 * exactly like the freeze marker - so it is a vault FILE, not a
 * `_brain.yaml` block. The strict machinery it borrows from the config
 * blocks is pattern, not import: field-named {@link PermissionsDocumentError}
 * raises, unknown-key warnings, and a `version` key that hard-refuses
 * anything but 1.
 *
 * The one split every consumer answers through {@link loadPermissionsDocument}:
 *
 *   - ABSENT - `{ document: null }`. The default posture; every gate
 *     proceeds exactly as it did before this document existed.
 *   - PRESENT BUT UNREADABLE - malformed YAML, a wrong-typed field, an
 *     unsupported version, a permission error, a directory in the file's
 *     place. The operator's policy exists and is NOT in force; answering
 *     with permissive silence would turn a typo into an open gate, so the
 *     loader throws and never returns a document.
 *
 * The YAML subset is the indent-aware one `src/core/brain/yaml-parse.ts`
 * established for `_brain.yaml`, extended with the one shape the schema
 * needs beyond it: a list of small mappings under `entries:`. Anchors,
 * aliases and deeply nested inline structures stay outside the grammar on
 * purpose - a policy file an operator cannot eyeball is a policy nobody
 * can trust.
 *
 * LEAF MODULE: imports nothing from the Brain layer. The resolver
 * (`./resolve.ts`), the ledger (`./ledger.ts`) and every gate lane build on
 * the types and the loader exported here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The vault-relative directory the document lives in. */
const DOCUMENT_DIRECTORY = "Brain";

/** The file name, beside `_brain.yaml` and the freeze marker. */
const DOCUMENT_BASENAME = "_permissions.yaml";

/** Vault-relative location of the permissions document. */
export const PERMISSIONS_DOCUMENT_REL = `${DOCUMENT_DIRECTORY}/${DOCUMENT_BASENAME}`;

/** The only schema version this build reads. Anything else hard-refuses. */
export const PERMISSIONS_SCHEMA_VERSION = 1;

/** What a rule says about one action. Deny wins every tie. */
export type PermissionVerdict = "allow" | "ask" | "deny";

/** What a rule is about: the two write lanes and the owner-stamp lane. */
export type PermissionAction = "write" | "ingest" | "owner_write";

/** The closed vocabularies, in the order equal-specificity ties resolve. */
const VERDICTS: ReadonlyArray<PermissionVerdict> = ["allow", "ask", "deny"];
const ACTIONS: ReadonlyArray<PermissionAction> = ["write", "ingest", "owner_write"];

/** One target-scoped exception or blanket rule the operator wrote. */
export interface PermissionEntry {
  id: string;
  agent?: string;
  role?: string;
  action: PermissionAction;
  target?: string;
  verdict: PermissionVerdict;
}

/**
 * The parsed document. `default_action` is REQUIRED - there is no silent
 * default - so a document is always a closed world the operator spelled.
 */
export interface PermissionsDocument {
  version: 1;
  default_action: PermissionVerdict;
  roles: Record<string, Partial<Record<PermissionAction, PermissionVerdict>>>;
  agents: Record<
    string,
    {
      role?: string;
      write?: PermissionVerdict;
      ingest?: PermissionVerdict;
      owner_write?: PermissionVerdict;
    }
  >;
  entries: PermissionEntry[];
  ledger?: { record_allows?: boolean };
}

/**
 * Why the document could not be read. The message always names the file
 * and, for every schema-level refusal, the exact field that refused.
 */
export class PermissionsDocumentError extends Error {}

// ----- YAML subset ----------------------------------------------------------

type YamlScalar = string | number | boolean | null;
type YamlValue = YamlScalar | YamlMapping | YamlValue[];
/** Insertion-ordered mapping; key order drives the deterministic warnings. */
interface YamlMapping {
  [key: string]: YamlValue;
}

interface Line {
  readonly indent: number;
  readonly content: string;
  readonly lineNumber: number;
}

/** A parse failure, carrying its line like `yaml-parse.ts` does. */
class YamlSyntaxError extends Error {}

/**
 * The subset's scalar grammar, shared with `yaml-parse.ts`: quoted strings
 * are taken verbatim, `true`/`false`/`null`/`~` are literals, plain
 * integers and finite decimals parse as numbers, everything else stays a
 * string - so `yes` and `no` are honest strings, not booleans.
 */
function parseScalar(text: string): YamlScalar {
  if (
    text.length >= 2 &&
    ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))
  ) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return parseFloat(text);
  return text;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber++;
    const stripped = raw.replace(/\s+$/, "");
    if (stripped.trim() === "" || stripped.trimStart().startsWith("#")) continue;
    // Inline comments are honoured only where they cannot be content: a
    // line carrying quotes keeps everything, the same rule yaml-parse uses.
    let content = stripped;
    if (!/['"]/.test(stripped)) {
      const hashAt = stripped.indexOf(" #");
      if (hashAt >= 0) content = stripped.slice(0, hashAt).replace(/\s+$/, "");
    }
    const indent = content.length - content.trimStart().length;
    out.push({ indent, content: content.slice(indent), lineNumber });
  }
  return out;
}

interface KeyValue {
  readonly key: string;
  readonly value: string;
}

function splitKeyValue(line: Line): KeyValue {
  const at = line.content.indexOf(":");
  if (at <= 0) {
    throw new YamlSyntaxError(
      `line ${line.lineNumber}: expected 'key: value', got: ${JSON.stringify(line.content)}`,
    );
  }
  const key = line.content.slice(0, at).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
    throw new YamlSyntaxError(`line ${line.lineNumber}: invalid key name: ${JSON.stringify(key)}`);
  }
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new YamlSyntaxError(`line ${line.lineNumber}: reserved key name: ${JSON.stringify(key)}`);
  }
  return { key, value: line.content.slice(at + 1).trim() };
}

/** True when the line opens a list item (`- ` prefix). */
function isListItem(line: Line): boolean {
  return line.content === "-" || line.content.startsWith("- ");
}

/**
 * Parse a mapping whose keys sit at exactly `indent`. A key with an empty
 * value opens either a nested mapping or a list at a deeper indent; with
 * nothing deeper, it stands for an empty mapping.
 */
function parseMapping(lines: Line[], start: number, indent: number): [YamlMapping, number] {
  const out: YamlMapping = {};
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (isListItem(line)) break;
    const { key, value } = splitKeyValue(line);
    if (key in out) {
      throw new YamlSyntaxError(`line ${line.lineNumber}: duplicate key '${key}'`);
    }
    if (value !== "") {
      out[key] = parseScalar(value);
      i++;
      // A scalar line followed by a deeper one is the shape a misdedented
      // block takes; refuse rather than guess which line is right.
      if (i < lines.length && lines[i]!.indent > indent) {
        throw new YamlSyntaxError(
          `line ${lines[i]!.lineNumber}: unexpected indentation under '${key}'`,
        );
      }
      continue;
    }
    i++;
    if (i < lines.length && lines[i]!.indent > indent) {
      const childIndent = lines[i]!.indent;
      const [child, next] = isListItem(lines[i]!)
        ? parseList(lines, i, childIndent)
        : parseMapping(lines, i, childIndent);
      out[key] = child;
      i = next;
    } else {
      out[key] = {};
    }
  }
  return [out, i];
}

/**
 * Parse a list whose `- ` items sit at exactly `indent`. An item whose
 * content names a key opens a small mapping: the inline pair is its first
 * entry and the siblings align two columns deeper (the `- ` width), which
 * is the layout the entries block takes.
 */
function parseList(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent && isListItem(lines[i]!)) {
    const line = lines[i]!;
    const item = line.content === "-" ? "" : line.content.slice(2).trim();
    const itemKey = item.indexOf(":");
    if (item === "") {
      throw new YamlSyntaxError(`line ${line.lineNumber}: empty list item is not supported`);
    }
    if (itemKey <= 0) {
      out.push(parseScalar(item));
      i++;
      continue;
    }
    // A mapping item: re-parse the inline pair plus the aligned siblings.
    const itemIndent = indent + 2;
    const synthetic: Line = {
      indent: itemIndent,
      content: item,
      lineNumber: line.lineNumber,
    };
    const rest = parseMapping([synthetic, ...lines.slice(i + 1)], 0, itemIndent);
    out.push(rest[0]);
    // Count how many input lines the item mapping consumed: the synthetic
    // first line plus everything after it up to the returned cursor.
    const consumed = rest[1] - 1;
    i += 1 + consumed;
    if (i < lines.length && lines[i]!.indent > indent && !isListItem(lines[i]!)) {
      throw new YamlSyntaxError(
        `line ${lines[i]!.lineNumber}: inconsistent indentation in list item ` +
          `(expected ${itemIndent}, got ${lines[i]!.indent})`,
      );
    }
  }
  return [out, i];
}

function parseDocumentYaml(text: string): YamlMapping {
  const lines = splitLines(text);
  if (lines.length === 0) return {};
  const [out, next] = parseMapping(lines, 0, 0);
  if (next < lines.length) {
    throw new YamlSyntaxError(
      `line ${lines[next]!.lineNumber}: unexpected indentation at the document level`,
    );
  }
  return out;
}

// ----- Validation -----------------------------------------------------------

function fail(path: string, field: string, message: string): PermissionsDocumentError {
  return new PermissionsDocumentError(`${path}: ${field}: ${message}`);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "string" ? JSON.stringify(value) : `a ${typeof value}`;
}

function isMapping(value: YamlValue | undefined): value is YamlMapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function warn(path: string, field: string): void {
  process.stderr.write(`warning: ${path}: ${field}: unknown field ignored (forward-compat)\n`);
}

function isVerdict(value: YamlValue): value is PermissionVerdict {
  return typeof value === "string" && (VERDICTS as ReadonlyArray<string>).includes(value);
}

function requireVerdict(path: string, field: string, value: YamlValue): PermissionVerdict {
  if (!isVerdict(value)) {
    throw fail(path, field, `must be one of ${VERDICTS.join(", ")}; got ${describeValue(value)}`);
  }
  return value;
}

/** A required string field: absent, non-string or blank all refuse by name. */
function requireString(path: string, field: string, value: YamlValue | undefined): string {
  if (value === undefined) throw fail(path, field, "is required");
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(path, field, `must be a non-empty string; got ${describeValue(value)}`);
  }
  return value;
}

/** An optional string field: absent stays absent, present must be a real string. */
function optionalString(
  path: string,
  field: string,
  value: YamlValue | undefined,
): string | undefined {
  return value === undefined ? undefined : requireString(path, field, value);
}

function parseActionMapping(
  path: string,
  field: string,
  value: YamlValue,
  warnings: string[],
): Partial<Record<PermissionAction, PermissionVerdict>> {
  if (!isMapping(value)) {
    throw fail(path, field, `must be a mapping; got ${describeValue(value)}`);
  }
  const out: Partial<Record<PermissionAction, PermissionVerdict>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!(ACTIONS as ReadonlyArray<string>).includes(key)) {
      warnings.push(`${field}.${key}`);
      continue;
    }
    out[key as PermissionAction] = requireVerdict(path, `${field}.${key}`, raw);
  }
  return out;
}

function validateRoles(
  path: string,
  raw: YamlValue,
  warnings: string[],
): Record<string, Partial<Record<PermissionAction, PermissionVerdict>>> {
  if (!isMapping(raw)) throw fail(path, "roles", `must be a mapping; got ${describeValue(raw)}`);
  const roles: Record<string, Partial<Record<PermissionAction, PermissionVerdict>>> = {};
  for (const [name, value] of Object.entries(raw)) {
    roles[name] = parseActionMapping(path, `roles.${name}`, value, warnings);
  }
  return roles;
}

const AGENT_ACTION_KEYS: ReadonlyArray<string> = ACTIONS;

function validateAgents(
  path: string,
  raw: YamlValue,
  warnings: string[],
): PermissionsDocument["agents"] {
  if (!isMapping(raw)) throw fail(path, "agents", `must be a mapping; got ${describeValue(raw)}`);
  const agents: PermissionsDocument["agents"] = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isMapping(value)) {
      throw fail(path, `agents.${name}`, `must be a mapping; got ${describeValue(value)}`);
    }
    const agent: PermissionsDocument["agents"][string] = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "role") {
        agent.role = requireString(path, `agents.${name}.role`, inner);
        continue;
      }
      if ((AGENT_ACTION_KEYS as ReadonlyArray<string>).includes(key)) {
        agent[key as PermissionAction] = requireVerdict(path, `agents.${name}.${key}`, inner);
        continue;
      }
      warnings.push(`agents.${name}.${key}`);
    }
    agents[name] = agent;
  }
  return agents;
}

function validateEntries(path: string, raw: YamlValue, warnings: string[]): PermissionEntry[] {
  if (!Array.isArray(raw)) throw fail(path, "entries", `must be a list; got ${describeValue(raw)}`);
  const entries: PermissionEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const field = `entries[${index}]`;
    if (!isMapping(item)) throw fail(path, field, `must be a mapping; got ${describeValue(item)}`);
    const id = requireString(path, `${field}.id`, item["id"]);
    const actionRaw = item["action"];
    if (actionRaw === undefined) {
      throw fail(path, `${field}.action`, "is required");
    }
    if (typeof actionRaw !== "string" || !(ACTIONS as ReadonlyArray<string>).includes(actionRaw)) {
      throw fail(
        path,
        `${field}.action`,
        `must be one of ${ACTIONS.join(", ")}; got ${describeValue(actionRaw)}`,
      );
    }
    const verdictRaw = item["verdict"];
    if (verdictRaw === undefined) {
      throw fail(path, `${field}.verdict`, "is required");
    }
    const verdict = requireVerdict(path, `${field}.verdict`, verdictRaw);
    const agent = optionalString(path, `${field}.agent`, item["agent"]);
    const role = optionalString(path, `${field}.role`, item["role"]);
    if (agent !== undefined && role !== undefined) {
      throw fail(
        path,
        field,
        "declares both agent and role; an entry names one principal, never two",
      );
    }
    const target = optionalString(path, `${field}.target`, item["target"]);
    for (const key of Object.keys(item)) {
      if (
        !(["id", "action", "verdict", "agent", "role", "target"] as ReadonlyArray<string>).includes(
          key,
        )
      ) {
        warnings.push(`${field}.${key}`);
      }
    }
    entries.push({
      id,
      ...(agent !== undefined ? { agent } : {}),
      ...(role !== undefined ? { role } : {}),
      action: actionRaw as PermissionAction,
      ...(target !== undefined ? { target } : {}),
      verdict,
    });
  }
  return entries;
}

function validateLedger(
  path: string,
  raw: YamlValue,
  warnings: string[],
): { record_allows?: boolean } {
  if (!isMapping(raw)) throw fail(path, "ledger", `must be a mapping; got ${describeValue(raw)}`);
  const ledger: { record_allows?: boolean } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "record_allows") {
      if (typeof value !== "boolean") {
        throw fail(path, `ledger.${key}`, `must be a boolean; got ${describeValue(value)}`);
      }
      ledger.record_allows = value;
      continue;
    }
    warnings.push(`ledger.${key}`);
  }
  return ledger;
}

/** The absolute path of the document inside `vault`. */
function documentPath(vault: string): string {
  return join(vault, DOCUMENT_DIRECTORY, DOCUMENT_BASENAME);
}

/**
 * Read the permissions document.
 *
 * ABSENT: `{ document: null }` and every consumer proceeds as today.
 * PRESENT: the file is parsed and validated strictly; anything it cannot
 * honour raises {@link PermissionsDocumentError} naming the file and the
 * field, and UNKNOWN keys warn on stderr while the document still loads.
 */
export function loadPermissionsDocument(vault: string): {
  document: PermissionsDocument | null;
  path: string;
} {
  const path = documentPath(vault);
  if (!existsSync(path)) return { document: null, path };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new PermissionsDocumentError(
      `${path}: could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let raw: YamlMapping;
  try {
    raw = parseDocumentYaml(text);
  } catch (err) {
    throw new PermissionsDocumentError(
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isMapping(raw)) {
    // A top-level list or scalar cannot carry a schema.
    throw new PermissionsDocumentError(
      `${path}: expected a mapping at the top level; got ${describeValue(raw)}`,
    );
  }

  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (
      !(
        [
          "version",
          "default_action",
          "roles",
          "agents",
          "entries",
          "ledger",
        ] as ReadonlyArray<string>
      ).includes(key)
    ) {
      warnings.push(key);
    }
  }

  const version = raw["version"];
  if (version !== PERMISSIONS_SCHEMA_VERSION) {
    throw fail(
      path,
      "version",
      `must be ${PERMISSIONS_SCHEMA_VERSION}; got ${describeValue(version)}`,
    );
  }
  const defaultRaw = raw["default_action"];
  if (defaultRaw === undefined) {
    throw fail(path, "default_action", "is required - a document is a closed world, not a filter");
  }
  const default_action = requireVerdict(path, "default_action", defaultRaw);
  const roles = raw["roles"] === undefined ? {} : validateRoles(path, raw["roles"], warnings);
  const agents = raw["agents"] === undefined ? {} : validateAgents(path, raw["agents"], warnings);
  const entries =
    raw["entries"] === undefined ? [] : validateEntries(path, raw["entries"], warnings);
  const ledger =
    raw["ledger"] === undefined ? undefined : validateLedger(path, raw["ledger"], warnings);

  // Warnings are emitted only once the document is known loadable, so a
  // refusing file never drowns its error in forward-compat noise.
  for (const field of warnings) warn(path, field);

  return {
    document: {
      version: 1,
      default_action,
      roles,
      agents,
      entries,
      ...(ledger !== undefined ? { ledger } : {}),
    },
    path,
  };
}
