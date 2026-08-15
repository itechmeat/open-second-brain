/**
 * Deterministic project scanner (Project History Suite, t_929da8a2).
 *
 * Stdlib-only structural facts: no network, no LLM, no per-language
 * parsing - directory layout, file extensions, and manifests are the
 * whole input, so the same tree always produces the same facts (the
 * generator's idempotency rests on this). Import-graph analysis is
 * explicitly out of scope (design doc).
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

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

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
}

export interface ManifestFact {
  readonly name: string | null;
  readonly version: string | null;
  readonly description: string | null;
  readonly dependencies: ReadonlyArray<string>;
}

export interface ProjectFacts {
  readonly root: string;
  readonly name: string;
  readonly manifest: ManifestFact | null;
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

/** Count one file's extension, the single place the mapping is defined. */
function tallyExtension(languages: Record<string, number>, path: string): void {
  const ext = extname(path).toLowerCase();
  if (ext !== "") languages[ext] = (languages[ext] ?? 0) + 1;
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

/**
 * A manifest and the object it was parsed from. The raw object travels
 * with the fact because entry-point detection needs `main` and `bin`,
 * which the fact does not carry - reading and parsing `package.json` a
 * second time to reach them was two syscalls and a parse for data
 * already in memory, and left two readers that could disagree about
 * what the file said.
 */
interface ManifestRead {
  readonly fact: ManifestFact;
  readonly raw: Record<string, unknown>;
}

function readManifest(root: string): ManifestRead | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const deps =
      typeof raw["dependencies"] === "object" && raw["dependencies"] !== null
        ? Object.keys(raw["dependencies"] as Record<string, unknown>).toSorted()
        : [];
    return {
      fact: Object.freeze({
        name: typeof raw["name"] === "string" ? raw["name"] : null,
        version: typeof raw["version"] === "string" ? raw["version"] : null,
        description: typeof raw["description"] === "string" ? raw["description"] : null,
        dependencies: Object.freeze(deps),
      }),
      raw,
    };
  } catch {
    return null;
  }
}

function moduleFact(name: string, path: string, stats: SubtreeStats): ModuleFact {
  return Object.freeze({
    name,
    path,
    files: stats.files,
    languages: Object.freeze(stats.languages),
    topFiles: Object.freeze(stats.paths.toSorted().slice(0, TOP_FILES_CAP)),
  });
}

function detectModules(total: WalkStats): ReadonlyArray<ModuleFact> {
  for (const base of MODULE_BASES) {
    const dirs = childDirs(total, base);
    if (dirs.length === 0) continue;
    return Object.freeze(
      dirs.map((name) =>
        moduleFact(name, `${base}/${name}`, subtreeStats(total, `${base}/${name}`)),
      ),
    );
  }
  // Flat layout: the project root is the single module, and the root walk
  // IS its walk - nothing is traversed a second time to learn that.
  return Object.freeze([moduleFact("root", ".", total)]);
}

function detectEntryPoints(root: string, manifest: ManifestRead | null): ReadonlyArray<string> {
  const points = new Set<string>();
  if (manifest !== null) {
    const raw = manifest.raw;
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
  const manifest = readManifest(root);
  const progress = progressCounter(OPERATION.architect, opts.onProgress);
  progress.start(ARCHITECT_STAGE.walk);
  const total = walkTree(root, progress, opts.safeguard);
  const testLayout = TEST_LAYOUTS.find((layout) => existsSync(join(root, layout))) ?? null;
  return Object.freeze({
    root,
    name: manifest?.fact.name ?? basename(root),
    manifest: manifest?.fact ?? null,
    entryPoints: detectEntryPoints(root, manifest),
    modules: detectModules(total),
    testLayout,
    totalFiles: total.files,
    languages: Object.freeze(total.languages),
  });
}
