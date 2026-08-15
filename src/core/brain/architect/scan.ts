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
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import type { ProgressCounter } from "../progress.ts";
import type { Safeguard } from "../safeguard.ts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
]);

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
   * The ENCLOSING run's counter, not a sink of its own.
   *
   * A run has one terminator: a scan that opened and finished its own
   * stream would report the operation as finished while the notes were
   * still unwritten. A caller that only wants to watch a scan builds the
   * counter itself - `progressCounter(OPERATION.architect, sink)` - and
   * calls `finish()` when it is done with it, which is exactly what
   * `generateArchDocs` does around this call.
   */
  readonly progress?: ProgressCounter;
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
  paths: string[];
}

function walk(dir: string, stats: WalkStats, prefix: string, opts: ScanProjectOptions): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  // One directory read, one boundary: the deadline is checked before the
  // count is claimed, so a tripped scan never reports work it abandoned.
  opts.safeguard?.checkpoint();
  opts.progress?.advance(ARCHITECT_STAGE.walk);
  for (const entry of entries.toSorted()) {
    if (SKIP_DIRS.has(entry)) continue;
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
      walk(abs, stats, rel, opts);
      continue;
    }
    stats.files += 1;
    stats.paths.push(rel);
    const ext = extname(entry).toLowerCase();
    if (ext !== "") stats.languages[ext] = (stats.languages[ext] ?? 0) + 1;
  }
}

function statsFor(dir: string, opts: ScanProjectOptions): WalkStats {
  const stats: WalkStats = { files: 0, languages: {}, paths: [] };
  walk(dir, stats, "", opts);
  return stats;
}

function listDirs(dir: string): ReadonlyArray<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .toSorted()
    .filter((entry) => !SKIP_DIRS.has(entry))
    .filter((entry) => {
      try {
        const stat = lstatSync(join(dir, entry));
        return !stat.isSymbolicLink() && stat.isDirectory();
      } catch {
        return false;
      }
    });
}

function readManifest(root: string): ManifestFact | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const deps =
      typeof raw["dependencies"] === "object" && raw["dependencies"] !== null
        ? Object.keys(raw["dependencies"] as Record<string, unknown>).toSorted()
        : [];
    return Object.freeze({
      name: typeof raw["name"] === "string" ? raw["name"] : null,
      version: typeof raw["version"] === "string" ? raw["version"] : null,
      description: typeof raw["description"] === "string" ? raw["description"] : null,
      dependencies: Object.freeze(deps),
    });
  } catch {
    return null;
  }
}

function detectModules(root: string, opts: ScanProjectOptions): ReadonlyArray<ModuleFact> {
  for (const base of ["src", "packages"]) {
    const baseDir = join(root, base);
    if (!existsSync(baseDir)) continue;
    const dirs = listDirs(baseDir);
    if (dirs.length === 0) continue;
    return Object.freeze(
      dirs.map((name) => {
        const stats = statsFor(join(baseDir, name), opts);
        return Object.freeze({
          name,
          path: `${base}/${name}`,
          files: stats.files,
          languages: Object.freeze(stats.languages),
          topFiles: Object.freeze(stats.paths.toSorted().slice(0, TOP_FILES_CAP)),
        });
      }),
    );
  }
  // Flat layout: the project root is the single module.
  const stats = statsFor(root, opts);
  return Object.freeze([
    Object.freeze({
      name: "root",
      path: ".",
      files: stats.files,
      languages: stats.languages,
      topFiles: Object.freeze(stats.paths.toSorted().slice(0, TOP_FILES_CAP)),
    }),
  ]);
}

function detectEntryPoints(root: string, manifest: ManifestFact | null): ReadonlyArray<string> {
  const points = new Set<string>();
  if (manifest !== null) {
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
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
  opts.progress?.start(ARCHITECT_STAGE.walk);
  const total = statsFor(root, opts);
  const testLayout = TEST_LAYOUTS.find((layout) => existsSync(join(root, layout))) ?? null;
  return Object.freeze({
    root,
    name: manifest?.name ?? basename(root),
    manifest,
    entryPoints: detectEntryPoints(root, manifest),
    modules: detectModules(root, opts),
    testLayout,
    totalFiles: total.files,
    languages: Object.freeze(total.languages),
  });
}
