/**
 * Repo-scoped driver for the hardcoded-path scanner.
 *
 * Decides *which* files of the OSB tree the hygiene check looks at —
 * shipped source, docs, generated examples, and plugin config templates
 * — and reads them off disk. The matching logic itself lives in the
 * pure {@link scanFiles} core; this module is the only part that touches
 * the filesystem, so tests can drive the core without walking a tree.
 *
 * Fixtures and the test tree are deliberately out of scope: they are
 * full of intentional example paths (`/home/u/vault`, `/Users/x/…`) and
 * are never installed on an operator's machine.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { IgnoreScope, parseIgnoreLayer, type IgnoreWarning } from "../fs/ignore.ts";
import { scanFiles, type HardcodedPathFinding } from "./hardcoded-paths.ts";

/**
 * Top-level directories walked recursively. Every entry is a surface
 * that ships to, or is read by, an operator installing OSB.
 */
export const SCAN_DIRS: ReadonlyArray<string> = [
  "src",
  "docs",
  "templates",
  "skills",
  "plugins",
  "scripts",
  "hooks",
  "install",
  "schemas",
  "bin",
];

/** Individually-scanned root files (docs / manifests, not whole dirs). */
export const SCAN_ROOT_FILES: ReadonlyArray<string> = [
  "README.md",
  "install.md",
  "after-install.md",
  "plugin.yaml",
  "openclaw.plugin.json",
];

/** Text extensions worth scanning. Binary/asset files are skipped. */
const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".txt",
  ".html",
  ".sh",
  ".py",
]);

/**
 * Path segments that exclude a file from the scan. `tests` and
 * `fixtures` hold intentional example paths; the rest are VCS / build
 * noise. `openclaw/index.js` is a generated bundle and is dropped by the
 * extension-less-of-interest check plus this list's `node_modules` guard
 * — but we also name it explicitly below.
 */
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  "dist",
  "build",
  "tests",
  "test",
  "fixtures",
  "__pycache__",
  ".venv",
]);

/** Generated artifacts scanned nowhere, matched by repo-relative path. */
const EXCLUDED_RELPATHS: ReadonlySet<string> = new Set([join("openclaw", "index.js")]);

function hasScanExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SCAN_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function isExcludedDir(name: string): boolean {
  return EXCLUDED_SEGMENTS.has(name);
}

/** Repo-root-relative POSIX path for an absolute path ("" when equal to root). */
function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/** Read one ignore file into the scope, folding any warnings in. Fail-soft on I/O. */
function extendWithIgnoreFile(
  scope: IgnoreScope,
  filePath: string,
  baseDir: string,
  source: string,
  warnings: IgnoreWarning[],
): IgnoreScope {
  if (!existsSync(filePath)) return scope;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return scope; // an unreadable ignore file is not a scan failure
  }
  const parsed = parseIgnoreLayer(content, baseDir, source);
  warnings.push(...parsed.warnings);
  return scope.extend(parsed.layer);
}

/**
 * Base ignore scope for the whole repo: `.git/info/exclude` at the lowest
 * precedence, then the root `.gitignore` above it. Nested `.gitignore` files
 * are layered per directory during the walk.
 */
function buildBaseScope(root: string, warnings: IgnoreWarning[]): IgnoreScope {
  let scope = IgnoreScope.empty();
  scope = extendWithIgnoreFile(
    scope,
    join(root, ".git", "info", "exclude"),
    "",
    ".git/info/exclude",
    warnings,
  );
  scope = extendWithIgnoreFile(scope, join(root, ".gitignore"), "", ".gitignore", warnings);
  return scope;
}

/**
 * Recursively collect scannable files under `dir`, fail-soft on I/O. `scope`
 * carries the composed ignore rules from all shallower directories; this
 * directory's own `.gitignore` (if any) is layered on top for its subtree, so
 * a deeper file scopes only what it governs and a nearer `!` re-include wins.
 */
function collectFiles(
  dir: string,
  root: string,
  scope: IgnoreScope,
  out: string[],
  warnings: IgnoreWarning[],
): void {
  const dirScope = extendWithIgnoreFile(
    scope,
    join(dir, ".gitignore"),
    toPosixRel(root, dir),
    `${toPosixRel(root, dir)}/.gitignore`,
    warnings,
  );
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing / unreadable dir is not a scan failure
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const posixRel = toPosixRel(root, abs);
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue;
      if (dirScope.isIgnored(posixRel, true)) continue;
      collectFiles(abs, root, dirScope, out, warnings);
    } else if (entry.isFile() && hasScanExtension(entry.name)) {
      if (EXCLUDED_RELPATHS.has(relative(root, abs))) continue;
      if (dirScope.isIgnored(posixRel, false)) continue;
      out.push(abs);
    }
  }
}

/** Emit one stderr line per malformed ignore pattern, deduplicated. */
function reportIgnoreWarnings(warnings: ReadonlyArray<IgnoreWarning>): void {
  const seen = new Set<string>();
  for (const w of warnings) {
    const key = `${w.source}:${w.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    process.stderr.write(
      `hygiene: ignoring malformed ignore pattern at ${w.source}:${w.line} ` +
        `(${w.pattern}): ${w.reason}\n`,
    );
  }
}

/**
 * Enumerate every in-scope file under `root`, as repo-relative paths.
 * Deterministic order (sorted after the walk) so reports diff cleanly
 * regardless of the readdir ordering the platform returns. Paths ignored by
 * the repo's `.gitignore` files (root and nested) and `.git/info/exclude` are
 * skipped in addition to the static skip-dir baseline; with no ignore files
 * present the result is byte-identical to the baseline walk.
 */
export function listScanTargets(root: string): string[] {
  const warnings: IgnoreWarning[] = [];
  const baseScope = buildBaseScope(root, warnings);
  const abs: string[] = [];
  for (const dir of SCAN_DIRS) {
    collectFiles(join(root, dir), root, baseScope, abs, warnings);
  }
  for (const name of SCAN_ROOT_FILES) {
    const p = join(root, name);
    try {
      // Honor the same ignore scope collectFiles applies to recursive targets,
      // so an ignored root file (e.g. a gitignored README.md) is not scanned.
      if (statSync(p).isFile() && !baseScope.isIgnored(toPosixRel(root, p), false)) {
        abs.push(p);
      }
    } catch {
      // absent root file is fine
    }
  }
  reportIgnoreWarnings(warnings);
  // Sort to guarantee stable cross-platform output: readdirSync is
  // alphabetical on POSIX (libuv alphasort) but not guaranteed on Windows.
  abs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return abs.map((p) => relative(root, p)).map((p) => p.split(sep).join("/"));
}

/**
 * Walk the OSB tree under `root`, read every in-scope file, and return
 * the hardcoded-path findings. Findings carry repo-relative POSIX paths
 * so they are stable across machines and cheap to assert on in tests.
 */
export function scanRepo(root: string): HardcodedPathFinding[] {
  const targets = listScanTargets(root);
  const files = targets.map((rel) => {
    let content = "";
    try {
      content = readFileSync(join(root, rel), "utf8");
    } catch {
      content = "";
    }
    return { file: rel, content };
  });
  return scanFiles(files);
}
