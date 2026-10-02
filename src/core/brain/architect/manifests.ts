/**
 * Manifest readers of the architecture scanner.
 *
 * One reading per dependency manifest, with a closed status for every
 * outcome: `read`, `malformed` (the file exists and does not parse),
 * `unreadable` (the file could not be read at all) and `unsupported` (a
 * recognised manifest whose dependencies this module does not read). A
 * broken manifest is a reading like any other, never a throw and never
 * the same `null` as an absent file: one bad manifest must not abort a
 * scan, and the operator has to see that it was not read.
 *
 * What is read is deterministic and declared, not measured: the names a
 * manifest lists as runtime dependencies, canonical per ecosystem,
 * deduplicated and sorted. The other dependency groups (dev, build,
 * optional, peer, indirect) are counted, not listed.
 *
 * Every string a reading carries is written into a note's region body,
 * so it is made safe to write here, once, for every consumer: a
 * dependency name that is not a plausible package name (a newline, a
 * space, a bracket) is dropped and counted in the `unrepresentable`
 * group, never silently; head fields are folded onto one line and cannot
 * open a wikilink; and a parse failure carries a fixed detail rather than
 * the parser's message, which quotes the manifest's own text.
 *
 * TOML is parsed with `Bun.TOML.parse`, a runtime built-in. This module
 * is not part of the OpenClaw bundle that runs on Node; if a future
 * build bundles the architect for Node, the TOML readers must move
 * behind a runtime check. The shared, Node-safe vocabulary lives in
 * `src/core/project-manifests.ts`.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";

import { manifestSpecFor, MANIFEST_ECOSYSTEM } from "../../project-manifests.ts";
import type { ManifestEcosystem, ManifestSpec } from "../../project-manifests.ts";

/** How one manifest was read. */
export const MANIFEST_STATUS = Object.freeze({
  read: "read",
  malformed: "malformed",
  unreadable: "unreadable",
  unsupported: "unsupported",
} as const);

export type ManifestStatus = (typeof MANIFEST_STATUS)[keyof typeof MANIFEST_STATUS];

export const MANIFEST_STATUSES: ReadonlyArray<ManifestStatus> = Object.freeze(
  Object.values(MANIFEST_STATUS),
);

export function isManifestStatus(value: unknown): value is ManifestStatus {
  return typeof value === "string" && (MANIFEST_STATUSES as ReadonlyArray<string>).includes(value);
}

/** The dependency groups that are counted rather than listed. */
export const DEPENDENCY_GROUP = Object.freeze({
  dev: "dev",
  build: "build",
  optional: "optional",
  peer: "peer",
  indirect: "indirect",
  /** Names dropped because a note cannot carry them; see {@link REPRESENTABLE_NAME}. */
  unrepresentable: "unrepresentable",
} as const);

export type DependencyGroup = (typeof DEPENDENCY_GROUP)[keyof typeof DEPENDENCY_GROUP];

export interface GroupCount {
  readonly group: DependencyGroup;
  readonly count: number;
}

/** What a read manifest says about its project. */
export interface ManifestFact {
  readonly name: string | null;
  readonly version: string | null;
  readonly description: string | null;
  /** Runtime dependencies: canonical, deduplicated, code-point sorted. */
  readonly dependencies: ReadonlyArray<string>;
}

export interface ManifestReading {
  /** Project-relative path with `/` separators. */
  readonly path: string;
  readonly ecosystem: ManifestEcosystem;
  readonly status: ManifestStatus;
  /** Location-free reason, only for `malformed` and `unreadable`. */
  readonly detail?: string;
  /** `null` unless the status is `read`. */
  readonly fact: ManifestFact | null;
  /** Counted groups, sorted by group, zero counts omitted. */
  readonly otherGroups: ReadonlyArray<GroupCount>;
  /** The parsed object, only for a read `package.json` (entry points). */
  readonly raw: Readonly<Record<string, unknown>> | null;
}

/** The parsed content of one manifest, before it becomes a reading. */
interface ParsedManifest {
  readonly fact: ManifestFact;
  readonly groups: ReadonlyMap<DependencyGroup, ReadonlySet<string>>;
  readonly raw: Readonly<Record<string, unknown>> | null;
}

/** A manifest whose text parses but whose shape is not a manifest. */
class ManifestShapeError extends Error {}

const NOT_A_TABLE_DETAIL = "top-level value is not a table";
const INVALID_JSON_DETAIL = "invalid JSON";
const INVALID_TOML_DETAIL = "invalid TOML";
/** A parser that runs out of stack on a deeply nested value throws a `RangeError`. */
const NESTING_TOO_DEEP_DETAIL = "nesting too deep";
/** A go.mod directive name, the only part of a go.mod a detail may quote. */
const GO_DIRECTIVE_NAME = /^[a-z]+$/;

/**
 * A dependency name a note can carry: the shape npm (scoped names
 * included), PEP 503, crates and Go module paths share, 214 characters
 * at most (npm's own limit). Anything else - a newline, a space, a
 * bracket - is not a package name any registry serves.
 */
const REPRESENTABLE_NAME = /^[A-Za-z0-9@_][A-Za-z0-9@._/~+:-]{0,213}$/;
/** C0 control characters, DEL and C1 control characters: what folds a string onto one line. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f]+/g;
const WIKILINK_OPEN = "[[";
/** `[[` with its second bracket escaped: reads the same, links nothing. */
const WIKILINK_OPEN_ESCAPED = "[\\[";

/** `text` on one line: every run of control characters becomes one space. */
export function oneLine(text: string): string {
  return text.replace(CONTROL_RUN, " ").trim();
}
/** The detail when a read failure carries no errno code. */
const UNKNOWN_READ_FAILURE = "read failed";

/** The largest manifest read, in bytes; a larger one is `unreadable`, unread. */
export const MANIFEST_MAX_BYTES = 1_048_576;
const TOO_LARGE_DETAIL = `larger than ${MANIFEST_MAX_BYTES} bytes`;
const NOT_A_REGULAR_FILE_DETAIL = "not a regular file";

/**
 * How a manifest is opened: read-only, never through a final-component
 * symlink (`ELOOP`), never blocking (a FIFO met where the walk saw a file
 * must not hang the scan). Both flags are POSIX; where the platform lacks
 * one it is simply absent.
 */
const MANIFEST_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** Poetry lists the interpreter constraint among its dependencies. */
const POETRY_PYTHON_KEY = "python";

/** PEP 508: a requirement's name ends at the first of these, or whitespace. */
const PEP_508_NAME_END = /[[(<>=!~;@\s]/;
/** PEP 503: runs of `-`, `_` and `.` are one separator. */
const PEP_503_SEPARATORS = /[-_.]+/g;

/** The name a dependency is known by in its ecosystem. */
export function canonicalDependencyName(ecosystem: ManifestEcosystem, declared: string): string {
  if (ecosystem === MANIFEST_ECOSYSTEM.pypi) {
    return declared.replace(PEP_503_SEPARATORS, "-").toLowerCase();
  }
  return declared;
}

/** A UTF-8 byte order mark, which npm and the TOML and go.mod readers all ignore. */
const BYTE_ORDER_MARK = "\uFEFF";

/**
 * Read the manifest at `relPath` under `root`. Every outcome of the
 * project's content is a reading; only a caller error throws: a basename
 * that is not a dependency manifest is a `TypeError` naming the path.
 */
export function readManifestAt(root: string, relPath: string): ManifestReading {
  const path = relPath.replaceAll("\\", "/");
  const spec = manifestSpecFor(basename(path));
  if (spec === undefined) {
    throw new TypeError(`not a dependency manifest: ${path}`);
  }
  if (!spec.dependencyReadable) return reading(path, spec, MANIFEST_STATUS.unsupported);
  let text: string;
  try {
    const read = readBounded(join(root, path));
    if (read.text === null) return reading(path, spec, MANIFEST_STATUS.unreadable, read.detail);
    text = read.text.startsWith(BYTE_ORDER_MARK)
      ? read.text.slice(BYTE_ORDER_MARK.length)
      : read.text;
  } catch (error) {
    return reading(path, spec, MANIFEST_STATUS.unreadable, errnoDetail(error));
  }
  let parsed: ParsedManifest | null;
  try {
    parsed = parseManifest(spec, text);
  } catch (error) {
    // Every detail is one of this module's fixed strings: a parser's own
    // message quotes the manifest's text, which must not reach a note.
    if (error instanceof ManifestShapeError) {
      return reading(path, spec, MANIFEST_STATUS.malformed, error.message);
    }
    if (error instanceof RangeError) {
      return reading(path, spec, MANIFEST_STATUS.malformed, NESTING_TOO_DEEP_DETAIL);
    }
    throw error;
  }
  if (parsed === null) return reading(path, spec, MANIFEST_STATUS.unsupported);
  return Object.freeze({
    path,
    ecosystem: spec.ecosystem,
    status: MANIFEST_STATUS.read,
    fact: parsed.fact,
    otherGroups: groupCounts(parsed.groups),
    raw: parsed.raw,
  });
}

/**
 * Read a manifest through ONE descriptor, so the checks hold for the
 * bytes read: the open refuses a symlink, the descriptor must be a
 * regular file, and no more than {@link MANIFEST_MAX_BYTES} is read
 * however large the file has grown since the `fstat`. The walk saw a
 * plain file here, but the tree may have changed since.
 */
function readBounded(
  abs: string,
):
  | { readonly text: string; readonly detail?: undefined }
  | { readonly text: null; readonly detail: string } {
  const fd = openSync(abs, MANIFEST_OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: null, detail: NOT_A_REGULAR_FILE_DETAIL };
    if (stat.size > MANIFEST_MAX_BYTES) return { text: null, detail: TOO_LARGE_DETAIL };
    // Sized to the file plus one byte, so growth since the fstat is seen;
    // a file that grew is read on into one buffer of the cap plus one byte.
    let buffer = Buffer.allocUnsafe(stat.size + 1);
    let filled = 0;
    for (;;) {
      // A full buffer is under the cap here: past it, the loop has returned.
      if (filled === buffer.length) buffer = Buffer.concat([buffer], MANIFEST_MAX_BYTES + 1);
      const read = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
      if (filled > MANIFEST_MAX_BYTES) return { text: null, detail: TOO_LARGE_DETAIL };
    }
    return { text: buffer.toString("utf8", 0, filled) };
  } finally {
    closeSync(fd);
  }
}

/** Parse one manifest's text, or `null` when this ecosystem has no reader. */
function parseManifest(spec: ManifestSpec, text: string): ParsedManifest | null {
  switch (spec.ecosystem) {
    case MANIFEST_ECOSYSTEM.npm:
      return parsePackageJson(text);
    case MANIFEST_ECOSYSTEM.pypi:
      return parsePyproject(text);
    case MANIFEST_ECOSYSTEM.cargo:
      return parseCargoToml(text);
    case MANIFEST_ECOSYSTEM.go:
      return parseGoMod(text);
    // Declared not dependency-readable in the shared vocabulary: no XML
    // reader in the runtime, and Maven, Gradle, Bundler and Composer
    // semantics cannot be read honestly from one file.
    case MANIFEST_ECOSYSTEM.maven:
    case MANIFEST_ECOSYSTEM.gradle:
    case MANIFEST_ECOSYSTEM.rubygems:
    case MANIFEST_ECOSYSTEM.composer:
      return null;
    default: {
      const unreachable: never = spec.ecosystem;
      throw new TypeError(`no manifest reader for ecosystem: ${String(unreachable)}`);
    }
  }
}

function reading(
  path: string,
  spec: ManifestSpec,
  status: ManifestStatus,
  detail?: string,
): ManifestReading {
  return Object.freeze({
    path,
    ecosystem: spec.ecosystem,
    status,
    ...(detail === undefined ? {} : { detail }),
    fact: null,
    otherGroups: Object.freeze([]),
    raw: null,
  });
}

function errnoDetail(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : UNKNOWN_READ_FAILURE;
}

// --- package.json --------------------------------------------------------

/** npm's counted groups, by the key that declares each. */
const NPM_COUNTED_GROUPS: ReadonlyArray<readonly [string, DependencyGroup]> = Object.freeze([
  ["devDependencies", DEPENDENCY_GROUP.dev],
  ["optionalDependencies", DEPENDENCY_GROUP.optional],
  ["peerDependencies", DEPENDENCY_GROUP.peer],
]);

function parsePackageJson(text: string): ParsedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ManifestShapeError(INVALID_JSON_DETAIL);
    throw error;
  }
  const raw = asTable(parsed);
  if (raw === null) throw new ManifestShapeError(NOT_A_TABLE_DETAIL);
  const groups = new GroupCollector(MANIFEST_ECOSYSTEM.npm);
  for (const [key, group] of NPM_COUNTED_GROUPS) groups.addAll(group, tableKeys(raw[key]));
  return {
    fact: fact(raw, groups, tableKeys(raw["dependencies"])),
    groups: groups.sets,
    raw: Object.freeze(raw),
  };
}

// --- pyproject.toml ------------------------------------------------------

function parsePyproject(text: string): ParsedManifest {
  const doc = parseToml(text);
  const project = asTable(doc["project"]) ?? {};
  const poetry = asTable(asTable(doc["tool"])?.["poetry"]) ?? {};
  const runtime = [
    ...pep508Names(project["dependencies"]),
    ...tableKeys(poetry["dependencies"]).filter(
      (name) => canonicalDependencyName(MANIFEST_ECOSYSTEM.pypi, name) !== POETRY_PYTHON_KEY,
    ),
  ];
  const groups = new GroupCollector(MANIFEST_ECOSYSTEM.pypi);
  for (const extra of tableValues(project["optional-dependencies"])) {
    groups.addAll(DEPENDENCY_GROUP.optional, pep508Names(extra));
  }
  for (const group of tableValues(doc["dependency-groups"])) {
    groups.addAll(DEPENDENCY_GROUP.dev, pep508Names(group));
  }
  groups.addAll(DEPENDENCY_GROUP.dev, tableKeys(poetry["dev-dependencies"]));
  for (const group of tableValues(poetry["group"])) {
    groups.addAll(DEPENDENCY_GROUP.dev, tableKeys(asTable(group)?.["dependencies"]));
  }
  return {
    // Poetry's head fields are the fallback when `[project]` leaves one out.
    fact: fact({ ...definedHead(poetry), ...definedHead(project) }, groups, runtime),
    groups: groups.sets,
    raw: null,
  };
}

/** The PEP 508 requirement names in a list, skipping non-strings. */
function pep508Names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    const end = trimmed.search(PEP_508_NAME_END);
    const name = end === -1 ? trimmed : trimmed.slice(0, end);
    if (name !== "") names.push(name);
  }
  return names;
}

const HEAD_KEYS = Object.freeze(["name", "version", "description"] as const);

/** The head fields of a table that are strings. */
function definedHead(table: Record<string, unknown>): Record<string, unknown> {
  const head: Record<string, unknown> = {};
  for (const key of HEAD_KEYS) {
    if (typeof table[key] === "string") head[key] = table[key];
  }
  return head;
}

// --- Cargo.toml ----------------------------------------------------------

/** Cargo's counted groups, by the table that declares each. */
const CARGO_COUNTED_GROUPS: ReadonlyArray<readonly [string, DependencyGroup]> = Object.freeze([
  ["dev-dependencies", DEPENDENCY_GROUP.dev],
  ["build-dependencies", DEPENDENCY_GROUP.build],
]);
const CARGO_RUNTIME_TABLE = "dependencies";

function parseCargoToml(text: string): ParsedManifest {
  const doc = parseToml(text);
  // The top level and every `[target.'<cfg>']` table declare the same
  // three dependency tables.
  const scopes: ReadonlyArray<Record<string, unknown>> = [
    doc,
    ...tableValues(doc["target"])
      .map(asTable)
      .filter((target): target is Record<string, unknown> => target !== null),
  ];
  const runtime: string[] = [];
  const groups = new GroupCollector(MANIFEST_ECOSYSTEM.cargo);
  for (const scope of scopes) {
    runtime.push(...cargoCrateNames(scope[CARGO_RUNTIME_TABLE]));
    for (const [table, group] of CARGO_COUNTED_GROUPS) {
      groups.addAll(group, cargoCrateNames(scope[table]));
    }
  }
  return {
    fact: fact(asTable(doc["package"]) ?? {}, groups, runtime),
    groups: groups.sets,
    raw: null,
  };
}

/** The real crate names of a dependency table: `package =` resolves a rename. */
function cargoCrateNames(value: unknown): string[] {
  return Object.entries(asTable(value) ?? {}).map(([key, entry]) => {
    const renamed = asTable(entry)?.["package"];
    return typeof renamed === "string" ? renamed : key;
  });
}

// --- go.mod --------------------------------------------------------------

const GO_MODULE_DIRECTIVE = "module";
const GO_REQUIRE_DIRECTIVE = "require";
const GO_BLOCK_OPEN = "(";
const GO_BLOCK_CLOSE = ")";
const GO_COMMENT = "//";
/** Go marks an indirect requirement with a comment `// indirect` or `// indirect; ...`. */
const GO_INDIRECT_COMMENT = /^indirect(?:;|$)/;
const GO_QUOTED = /^(["`])(.*)\1$/;
/** Go's lexer makes each parenthesis a token of its own, so `require(` opens a block. */
const GO_PAREN = /[()]/g;

/**
 * A line reader for go.mod. Only `module` and `require` are read; every
 * other directive (`go`, `toolchain`, `replace`, `exclude`, `retract`
 * and any later one), single-line or block, is skipped. A parenthesis is a
 * token of its own, as in Go's lexer, so `require (` and `require(` both
 * open a block (gofmt writes the first; the second is still valid go.mod).
 */
function parseGoMod(text: string): ParsedManifest {
  let modulePath: string | null = null;
  let block: string | null = null;
  const runtime: string[] = [];
  const groups = new GroupCollector(MANIFEST_ECOSYSTEM.go);
  for (const line of text.split(/\r?\n/)) {
    const commentAt = line.indexOf(GO_COMMENT);
    const code = commentAt === -1 ? line : line.slice(0, commentAt);
    const comment = commentAt === -1 ? "" : line.slice(commentAt + GO_COMMENT.length).trim();
    const tokens = code
      .replace(GO_PAREN, " $& ")
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "")
      .map(unquoteGo);
    if (tokens.length === 0) continue;
    let entry: string[] | null = null;
    if (block !== null) {
      if (tokens[0] === GO_BLOCK_CLOSE) block = null;
      else if (block === GO_REQUIRE_DIRECTIVE) entry = tokens;
    } else if (tokens[1] === GO_BLOCK_OPEN) {
      // `require ()` opens and closes an empty block on one line.
      block = tokens.length > 2 && tokens.at(-1) === GO_BLOCK_CLOSE ? null : tokens[0]!;
    } else if (tokens[0] === GO_MODULE_DIRECTIVE) {
      modulePath = tokens[1] ?? null;
    } else if (tokens[0] === GO_REQUIRE_DIRECTIVE) {
      entry = tokens.slice(1);
    }
    if (entry === null) continue;
    if (entry.length < 2) throw new ManifestShapeError("require entry has no version");
    if (GO_INDIRECT_COMMENT.test(comment)) groups.addAll(DEPENDENCY_GROUP.indirect, [entry[0]!]);
    else runtime.push(entry[0]!);
  }
  if (block !== null) {
    const directive = GO_DIRECTIVE_NAME.test(block) ? block : "directive";
    throw new ManifestShapeError(`unterminated ${directive} block`);
  }
  return {
    fact: fact({ name: modulePath }, groups, runtime),
    groups: groups.sets,
    raw: null,
  };
}

/** A go.mod token without its interpreted or raw string quotes. */
function unquoteGo(token: string): string {
  return GO_QUOTED.exec(token)?.[2] ?? token;
}

// --- shared helpers ------------------------------------------------------

function parseToml(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ManifestShapeError(INVALID_TOML_DETAIL);
    throw error;
  }
  const doc = asTable(parsed);
  if (doc === null) throw new ManifestShapeError(NOT_A_TABLE_DETAIL);
  return doc;
}

/**
 * The fact of a read manifest. Runtime names a note cannot carry are
 * counted in `groups` as unrepresentable rather than listed.
 */
function fact(
  head: Record<string, unknown>,
  groups: GroupCollector,
  declared: ReadonlyArray<string>,
): ManifestFact {
  return Object.freeze({
    name: headText(head["name"]),
    version: headText(head["version"]),
    description: headText(head["description"]),
    dependencies: Object.freeze(
      [...new Set(groups.canonical(declared))].toSorted(compareCodePoints),
    ),
  });
}

/** A head field as a note writes it: one line, unable to open a wikilink. */
function headText(value: unknown): string | null {
  const text = stringOrNull(value);
  return text === null ? null : oneLine(text).replaceAll(WIKILINK_OPEN, WIKILINK_OPEN_ESCAPED);
}

/** Collects the canonical names of each counted group. */
class GroupCollector {
  readonly sets = new Map<DependencyGroup, Set<string>>();

  constructor(private readonly ecosystem: ManifestEcosystem) {}

  /**
   * The canonical names of the declared names a note can carry, in
   * declaration order. Every other name is counted as unrepresentable.
   */
  canonical(declared: Iterable<string>): string[] {
    const names: string[] = [];
    for (const name of declared) {
      if (REPRESENTABLE_NAME.test(name)) names.push(canonicalDependencyName(this.ecosystem, name));
      else this.add(DEPENDENCY_GROUP.unrepresentable, name);
    }
    return names;
  }

  addAll(group: DependencyGroup, declared: Iterable<string>): void {
    for (const name of this.canonical(declared)) this.add(group, name);
  }

  private add(group: DependencyGroup, name: string): void {
    let set = this.sets.get(group);
    if (set === undefined) {
      set = new Set();
      this.sets.set(group, set);
    }
    set.add(name);
  }
}

function groupCounts(
  groups: ReadonlyMap<DependencyGroup, ReadonlySet<string>>,
): ReadonlyArray<GroupCount> {
  const counts: GroupCount[] = [];
  for (const [group, names] of groups) {
    if (names.size > 0) counts.push(Object.freeze({ group, count: names.size }));
  }
  return Object.freeze(counts.toSorted((a, b) => compareCodePoints(a.group, b.group)));
}

/**
 * True code-point order, which `<` on strings is not: it compares UTF-16
 * code units, so a supplementary character sorts before U+E000-U+FFFF.
 * Every list of dependency names is ordered with this one comparator.
 */
export function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** A plain object (JSON object or TOML table), or `null`. */
function asTable(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tableKeys(value: unknown): string[] {
  return Object.keys(asTable(value) ?? {});
}

function tableValues(value: unknown): unknown[] {
  return Object.values(asTable(value) ?? {});
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
