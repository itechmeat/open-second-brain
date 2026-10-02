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
 * TOML is parsed with `Bun.TOML.parse`, a runtime built-in. This module
 * is not part of the OpenClaw bundle that runs on Node; if a future
 * build bundles the architect for Node, the TOML readers must move
 * behind a runtime check. The shared, Node-safe vocabulary lives in
 * `src/core/project-manifests.ts`.
 */

import { readFileSync } from "node:fs";
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
/** The detail when a read failure carries no errno code. */
const UNKNOWN_READ_FAILURE = "read failed";

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
    text = readFileSync(join(root, path), "utf8");
  } catch (error) {
    return reading(path, spec, MANIFEST_STATUS.unreadable, errnoDetail(error));
  }
  let parsed: ParsedManifest | null;
  try {
    parsed = parseManifest(spec, text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ManifestShapeError) {
      return reading(path, spec, MANIFEST_STATUS.malformed, error.message);
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
  const raw = asTable(JSON.parse(text));
  if (raw === null) throw new ManifestShapeError(NOT_A_TABLE_DETAIL);
  const groups = new GroupCollector(MANIFEST_ECOSYSTEM.npm);
  for (const [key, group] of NPM_COUNTED_GROUPS) groups.addAll(group, tableKeys(raw[key]));
  return {
    fact: fact(raw, MANIFEST_ECOSYSTEM.npm, tableKeys(raw["dependencies"])),
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
    ...tableKeys(poetry["dependencies"]).filter((name) => name !== POETRY_PYTHON_KEY),
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
    fact: fact(
      { ...definedHead(poetry), ...definedHead(project) },
      MANIFEST_ECOSYSTEM.pypi,
      runtime,
    ),
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
    fact: fact(asTable(doc["package"]) ?? {}, MANIFEST_ECOSYSTEM.cargo, runtime),
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
      block = tokens[0]!;
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
  if (block !== null) throw new ManifestShapeError(`unterminated ${block} block`);
  return {
    fact: fact({ name: modulePath }, MANIFEST_ECOSYSTEM.go, runtime),
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
  const doc = asTable(Bun.TOML.parse(text));
  if (doc === null) throw new ManifestShapeError(NOT_A_TABLE_DETAIL);
  return doc;
}

function fact(
  head: Record<string, unknown>,
  ecosystem: ManifestEcosystem,
  declared: ReadonlyArray<string>,
): ManifestFact {
  return Object.freeze({
    name: stringOrNull(head["name"]),
    version: stringOrNull(head["version"]),
    description: stringOrNull(head["description"]),
    dependencies: Object.freeze(canonicalSet(ecosystem, declared)),
  });
}

/** Canonical, deduplicated, code-point sorted names. */
function canonicalSet(ecosystem: ManifestEcosystem, declared: Iterable<string>): string[] {
  const names = new Set<string>();
  for (const name of declared) names.add(canonicalDependencyName(ecosystem, name));
  return [...names].toSorted(compareCodePoints);
}

/** Collects the canonical names of each counted group. */
class GroupCollector {
  readonly sets = new Map<DependencyGroup, Set<string>>();

  constructor(private readonly ecosystem: ManifestEcosystem) {}

  addAll(group: DependencyGroup, declared: Iterable<string>): void {
    let set = this.sets.get(group);
    for (const name of declared) {
      if (set === undefined) {
        set = new Set();
        this.sets.set(group, set);
      }
      set.add(canonicalDependencyName(this.ecosystem, name));
    }
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

function compareCodePoints(a: string, b: string): number {
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
