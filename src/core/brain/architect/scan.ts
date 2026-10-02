/**
 * Deterministic project scanner (Project History Suite, t_929da8a2).
 *
 * Built-in runtime only, no dependency: no network, no LLM, no
 * per-language parsing - directory layout, file extensions, and
 * dependency manifests are the whole input, so the same tree always
 * produces the same facts (the generator's idempotency rests on this).
 * Import-graph analysis is explicitly out of scope (design doc).
 *
 * Manifests are read at the project root and at every detected module
 * path, found in the walk's own path list (`manifests.ts` reads them and
 * records a manifest it cannot read rather than swallowing it). The walk
 * skips symlinks, so a manifest that is a symlink is not read. The only
 * module-to-module relation this scan states is one a manifest DECLARES:
 * a module whose manifest names, as a runtime dependency, the manifest
 * name of exactly one other module in the same ecosystem.
 *
 * Module detection prefers `src/<dir>` children, then `packages/<dir>`,
 * and degrades to a single `root` module on flat layouts rather than
 * guessing.
 *
 * The tree is walked exactly ONCE and every fact is derived from that one
 * traversal, because the walk is where this module's wall clock lives -
 * a scan of this repository is dominated by `statx` and `getdents64`.
 * What the walk refuses to enter is decided by {@link isSkippedDir},
 * which carries the measurement behind that decision.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { DEPENDENCY_MANIFESTS } from "../../project-manifests.ts";
import { resolveUniqueMatch } from "../../graph/unique-match.ts";
import { canonicalDependencyName, MANIFEST_STATUS, readManifestAt } from "./manifests.ts";
import type { ManifestFact, ManifestReading } from "./manifests.ts";
import { OPERATION, progressCounter, progressReasonForError } from "../progress.ts";
import type { ProgressCounter, ProgressSink } from "../progress.ts";
import type { Safeguard } from "../safeguard.ts";

/**
 * Build outputs and dependency trees the walk never enters, for the ones
 * that are conventionally NOT dot-named. The dot-named members this list
 * used to carry (`.git`, `.venv`, `.next`, `.cache`) are covered by the
 * rule in {@link isSkippedDir} and would be duplicates here.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  "venv",
  "__pycache__",
]);

/**
 * Whether a DIRECTORY named `name` is one the scan refuses to enter.
 * A file that happens to share one of those names is still a file.
 *
 * Two rules, and deliberately no ignore-file parsing.
 *
 * A dot-named directory is tooling state - agent worktrees, CI
 * definitions, caches, editor state - and architecture notes describe
 * none of it. Measured on this repository: of the 24124 files the scan
 * visited, 21422 (88%) are inside a dot directory, and 21113 of those
 * are one agent-worktree tree under `.claude/`.
 *
 * `.gitignore` was measured against the same tree before being rejected.
 * Honouring every `.gitignore` in it - nested files included - removes
 * exactly 12 of the directories the walk enters, holding 207 files, and
 * every one of them is already inside a dot directory. The 21k-file cost
 * this rule exists for appears in NO `.gitignore`: it is excluded by
 * `.git/info/exclude`, which is local state a project does not ship. A
 * gitignore matcher is real semantics - negation, anchoring,
 * directory-only patterns, precedence across nested files - and on the
 * repository it was proposed for it would have bought nothing the two
 * rules above do not, at the price of a surface that can silently
 * mis-scan every other project.
 */
function isSkippedDir(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

const ENTRY_CANDIDATES = [
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "src/main.py",
  "index.ts",
  "index.js",
  "main.py",
  "main.go",
  "src/main.rs",
];

const TEST_LAYOUTS = ["tests", "test", "__tests__", "spec"];

/** Where modules are looked for, in preference order. */
const MODULE_BASES = ["src", "packages"];

export interface ModuleFact {
  readonly name: string;
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly files: number;
  readonly languages: Readonly<Record<string, number>>;
  /** Module-relative file paths, sorted, capped for note rendering. */
  readonly topFiles: ReadonlyArray<string>;
  /** The dependency manifests at this module's path, in precedence order. */
  readonly manifests: ReadonlyArray<ManifestReading>;
}

export type { ManifestFact } from "./manifests.ts";

/**
 * One module's manifest declaring a runtime dependency on another
 * module's manifest name. Module names, never paths: the generator links
 * module notes, which are named after their module.
 */
export interface ModuleDependency {
  readonly from: string;
  readonly to: string;
}

export interface ProjectFacts {
  readonly root: string;
  readonly name: string;
  /**
   * Name, version and description of the first root manifest READ in
   * precedence order (`DEPENDENCY_MANIFESTS`); `null` when no root
   * manifest was read.
   */
  readonly manifest: ManifestFact | null;
  /** Every manifest read or attempted, root and modules, sorted by path. */
  readonly manifests: ReadonlyArray<ManifestReading>;
  /** Declared module-to-module edges, sorted by `from`, then `to`. */
  readonly moduleDependencies: ReadonlyArray<ModuleDependency>;
  readonly entryPoints: ReadonlyArray<string>;
  readonly modules: ReadonlyArray<ModuleFact>;
  readonly testLayout: string | null;
  readonly totalFiles: number;
  readonly languages: Readonly<Record<string, number>>;
}

const TOP_FILES_CAP = 20;

/**
 * The two stages of one architect run, in the order they run.
 *
 * Declared here rather than beside the renderer because this module is
 * the leaf of the pair's import edge, and because the two names only mean
 * anything together: `walk` is a counter with no denominator (the file
 * count is not known until the walk ends), `render` has one (the note
 * count is `1 + modules.length`, known the moment the walk is over).
 */
export const ARCHITECT_STAGE = Object.freeze({
  walk: "walk",
  render: "render",
} as const);

export interface ScanProjectOptions {
  /**
   * Where a caller watches the walk. Absence means nobody asked.
   *
   * The scan opens the `walk` stage and never closes the stream: the
   * render stage of the same run follows it, and one run has one
   * terminator. This is the shape `runIndex` and `runEmbeddingPhase`
   * already use for the two halves of an index run.
   */
  readonly onProgress?: ProgressSink;
  /**
   * Cooperative deadline, checked once per directory read. That is the
   * walk's only natural boundary: everything between two `readdirSync`
   * calls is a bounded loop over one directory's entries.
   */
  readonly safeguard?: Safeguard;
}

interface WalkStats {
  files: number;
  languages: Record<string, number>;
  /** Project-relative POSIX paths of every file, in walk order. */
  paths: string[];
  /** Project-relative POSIX paths of every directory the walk entered. */
  dirs: string[];
}

/**
 * UTF-16 code-unit order, not `localeCompare`: ICU collation varies with the
 * runtime locale, so a collator-based tie-break renders different bytes
 * for the same tree on two hosts - and byte-identical regeneration is the
 * generator's whole contract. Plain `toSorted()` on strings already does
 * this; the comparator exists for the orderings that need a tie-break
 * (language counts) or sort objects rather than strings. Dependency
 * names are the exception: they are ordered in true code-point order by
 * `compareCodePoints` in `manifests.ts`, in the fact and in the rendering.
 *
 * It lives here, in the leaf of the scan/render pair, because both the
 * renderer and the decision-candidate reader order their output with it
 * and neither may import the other.
 */
export function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What an extension must look like to be counted. A file name is text from
 * the scanned tree; one whose extension holds a line break, a space or a
 * bracket names no language, and is counted as having no extension.
 */
const COUNTED_EXTENSION = /^\.[a-z0-9_+-]{1,16}$/;

/** Count one file's extension, the single place the mapping is defined. */
function tallyExtension(languages: Record<string, number>, path: string): void {
  const ext = extname(path).toLowerCase();
  if (COUNTED_EXTENSION.test(ext)) languages[ext] = (languages[ext] ?? 0) + 1;
}

function walk(
  dir: string,
  stats: WalkStats,
  prefix: string,
  progress: ProgressCounter,
  safeguard: Safeguard | undefined,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  // One directory read, one boundary: the deadline is checked before the
  // count is claimed, so a tripped scan never reports work it abandoned.
  safeguard?.checkpoint();
  progress.advance(ARCHITECT_STAGE.walk);
  for (const entry of entries.toSorted()) {
    const abs = join(dir, entry);
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    let stat;
    try {
      // lstat: a symlinked directory must not pull the walk outside the
      // project tree or into a cycle - symlinks are skipped entirely.
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (isSkippedDir(entry)) continue;
      stats.dirs.push(rel);
      walk(abs, stats, rel, progress, safeguard);
      continue;
    }
    stats.files += 1;
    stats.paths.push(rel);
    tallyExtension(stats.languages, entry);
  }
}

/**
 * The one traversal, reporting a stop on the stage it stopped in.
 *
 * The stage a deadline interrupts is this counter's, so this is where the
 * `stopped` event belongs - the renderer's counter has not opened a stage
 * yet and could only report the stop into silence.
 */
function walkTree(
  root: string,
  progress: ProgressCounter,
  safeguard: Safeguard | undefined,
): WalkStats {
  const stats: WalkStats = { files: 0, languages: {}, paths: [], dirs: [] };
  try {
    walk(root, stats, "", progress, safeguard);
    return stats;
  } catch (error) {
    const reason = progressReasonForError(error);
    if (reason !== null) progress.stop(reason);
    throw error;
  }
}

/** What one subtree of an already-walked tree contains. */
interface SubtreeStats {
  readonly files: number;
  readonly languages: Record<string, number>;
  /** Subtree-relative POSIX paths. */
  readonly paths: ReadonlyArray<string>;
}

/**
 * The stats of `prefix` read out of the whole-tree walk, with no second
 * traversal: the walk already visited every file under it, and a path is
 * under `prefix` exactly when it starts with `prefix/`.
 */
function subtreeStats(total: WalkStats, prefix: string): SubtreeStats {
  const head = `${prefix}/`;
  const paths = total.paths
    .filter((path) => path.startsWith(head))
    .map((p) => p.slice(head.length));
  const languages: Record<string, number> = {};
  for (const path of paths) tallyExtension(languages, path);
  return { files: paths.length, languages, paths };
}

/**
 * Direct child directories of `base`, from the same walk. Sorted, because
 * module order decides the rendered note order and must not depend on
 * traversal order.
 */
function childDirs(total: WalkStats, base: string): ReadonlyArray<string> {
  const head = `${base}/`;
  return total.dirs
    .filter((dir) => dir.startsWith(head) && !dir.slice(head.length).includes("/"))
    .map((dir) => dir.slice(head.length))
    .toSorted();
}

/** The flat layout's single module, whose path is the project root. */
const ROOT_MODULE_PATH = ".";

/**
 * The dependency manifests directly at `dir` (project-relative, `.` for
 * the root), in precedence order, found in the walk's path list - so a
 * manifest is read only where the walk saw a file, and nothing is
 * traversed a second time to find it.
 */
function readManifestsAt(
  root: string,
  files: ReadonlySet<string>,
  dir: string,
): ReadonlyArray<ManifestReading> {
  const readings: ManifestReading[] = [];
  for (const spec of DEPENDENCY_MANIFESTS) {
    const rel = dir === ROOT_MODULE_PATH ? spec.file : `${dir}/${spec.file}`;
    if (files.has(rel)) readings.push(readManifestAt(root, rel));
  }
  return Object.freeze(readings);
}

/**
 * The root reading that speaks for the project: the first read one that
 * names it, in the order given, else the first read one. A manifest that
 * only configures tools (a `pyproject.toml` with just `[tool.ruff]`) must
 * not hide the name of a later one.
 */
function firstRead(readings: ReadonlyArray<ManifestReading>): ManifestReading | null {
  const read = readings.filter((reading) => reading.status === MANIFEST_STATUS.read);
  return read.find((reading) => reading.fact?.name != null) ?? read[0] ?? null;
}

/**
 * One identity per ecosystem: the key two manifests share when they name
 * one package. `name` is already canonical (a declared dependency is; a
 * manifest's own name goes through `canonicalDependencyName` first).
 */
export function manifestIdentity(ecosystem: string, name: string): string {
  return `${ecosystem}\u0000${name}`;
}

/**
 * The manifest identities a module answers to: the canonical name of each
 * of its read manifests, keyed by ecosystem.
 */
function moduleIdentities(module: ModuleFact): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const reading of module.manifests) {
    const name = reading.fact?.name;
    if (name == null) continue;
    keys.push(
      manifestIdentity(reading.ecosystem, canonicalDependencyName(reading.ecosystem, name)),
    );
  }
  return keys;
}

/**
 * The module manifest identities that bind to exactly one module: the
 * names that become module edges, not external packages. A name two
 * modules' manifests share binds nothing (see
 * {@link detectModuleDependencies}), so it stays an external name.
 */
export function moduleManifestIdentities(modules: ReadonlyArray<ModuleFact>): ReadonlySet<string> {
  const owners = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const key of moduleIdentities(module)) {
      const names = owners.get(key) ?? new Set<string>();
      names.add(module.name);
      owners.set(key, names);
    }
  }
  return new Set([...owners].filter(([, names]) => names.size === 1).map(([key]) => key));
}

/**
 * Module-to-module edges, as the manifests declare them.
 *
 * A declared dependency binds under the exactly-one rule
 * ({@link resolveUniqueMatch}): a name two modules' manifests carry binds
 * nothing, because picking one would state a relation nothing decided.
 * A module naming itself is not an edge. Sorted, so the facts do not
 * depend on module or manifest order.
 */
function detectModuleDependencies(
  modules: ReadonlyArray<ModuleFact>,
): ReadonlyArray<ModuleDependency> {
  const owners = new Map<string, string[]>();
  for (const module of modules) {
    for (const key of moduleIdentities(module)) {
      const list = owners.get(key) ?? [];
      list.push(module.name);
      owners.set(key, list);
    }
  }
  const edges = new Map<string, ModuleDependency>();
  for (const module of modules) {
    for (const reading of module.manifests) {
      for (const dependency of reading.fact?.dependencies ?? []) {
        const verdict = resolveUniqueMatch(
          owners.get(manifestIdentity(reading.ecosystem, dependency)) ?? [],
        );
        if (verdict.status !== "unique" || verdict.target === module.name) continue;
        const edge = Object.freeze({ from: module.name, to: verdict.target });
        edges.set(`${edge.from}\u0000${edge.to}`, edge);
      }
    }
  }
  return Object.freeze(
    [...edges.values()].toSorted(
      (a, b) => compareStable(a.from, b.from) || compareStable(a.to, b.to),
    ),
  );
}

/** Root and module readings, one per path, sorted by path. */
function allManifests(
  rootManifests: ReadonlyArray<ManifestReading>,
  modules: ReadonlyArray<ModuleFact>,
): ReadonlyArray<ManifestReading> {
  const byPath = new Map<string, ManifestReading>();
  for (const reading of [...rootManifests, ...modules.flatMap((module) => module.manifests)]) {
    byPath.set(reading.path, reading);
  }
  return Object.freeze([...byPath.values()].toSorted((a, b) => compareStable(a.path, b.path)));
}

function moduleFact(
  name: string,
  path: string,
  stats: SubtreeStats,
  manifests: ReadonlyArray<ManifestReading>,
): ModuleFact {
  return Object.freeze({
    name,
    path,
    files: stats.files,
    languages: Object.freeze(stats.languages),
    topFiles: Object.freeze(stats.paths.toSorted().slice(0, TOP_FILES_CAP)),
    manifests,
  });
}

function detectModules(
  root: string,
  total: WalkStats,
  files: ReadonlySet<string>,
  rootManifests: ReadonlyArray<ManifestReading>,
): ReadonlyArray<ModuleFact> {
  for (const base of MODULE_BASES) {
    const dirs = childDirs(total, base);
    if (dirs.length === 0) continue;
    return Object.freeze(
      dirs.map((name) => {
        const path = `${base}/${name}`;
        return moduleFact(
          name,
          path,
          subtreeStats(total, path),
          readManifestsAt(root, files, path),
        );
      }),
    );
  }
  // Flat layout: the project root is the single module, and the root walk
  // IS its walk - nothing is traversed a second time to learn that. Its
  // manifests are the root's, already read.
  return Object.freeze([moduleFact("root", ROOT_MODULE_PATH, total, rootManifests)]);
}

/**
 * Entry points from a read root `package.json` (`main`, `bin`) and the
 * conventional candidates. The raw object travels on the reading because
 * `main` and `bin` are not part of the fact; reading the file a second
 * time would leave two readers that could disagree about what it said.
 */
function detectEntryPoints(
  root: string,
  rootManifests: ReadonlyArray<ManifestReading>,
): ReadonlyArray<string> {
  const points = new Set<string>();
  const raw = rootManifests.find((reading) => reading.raw !== null)?.raw ?? null;
  if (raw !== null) {
    if (typeof raw["main"] === "string") points.add(raw["main"]);
    if (typeof raw["bin"] === "object" && raw["bin"] !== null) {
      for (const value of Object.values(raw["bin"] as Record<string, unknown>)) {
        if (typeof value === "string") points.add(value.replace(/^\.\//, ""));
      }
    }
  }
  for (const candidate of ENTRY_CANDIDATES) {
    if (existsSync(join(root, candidate))) points.add(candidate);
  }
  return Object.freeze([...points].toSorted());
}

/** Scan one project tree into deterministic structural facts. */
export function scanProject(projectRoot: string, opts: ScanProjectOptions = {}): ProjectFacts {
  const root = resolve(projectRoot);
  const progress = progressCounter(OPERATION.architect, opts.onProgress);
  progress.start(ARCHITECT_STAGE.walk);
  const total = walkTree(root, progress, opts.safeguard);
  const files: ReadonlySet<string> = new Set(total.paths);
  const rootManifests = readManifestsAt(root, files, ROOT_MODULE_PATH);
  const manifest = firstRead(rootManifests)?.fact ?? null;
  const modules = detectModules(root, total, files, rootManifests);
  const testLayout = TEST_LAYOUTS.find((layout) => existsSync(join(root, layout))) ?? null;
  return Object.freeze({
    root,
    name: manifest?.name ?? basename(root),
    manifest,
    manifests: allManifests(rootManifests, modules),
    moduleDependencies: detectModuleDependencies(modules),
    entryPoints: detectEntryPoints(root, rootManifests),
    modules,
    testLayout,
    totalFiles: total.files,
    languages: Object.freeze(total.languages),
  });
}
