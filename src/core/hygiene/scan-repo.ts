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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

/** Recursively collect scannable files under `dir`, fail-soft on I/O. */
function collectFiles(dir: string, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing / unreadable dir is not a scan failure
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue;
      collectFiles(abs, root, out);
    } else if (entry.isFile() && hasScanExtension(entry.name)) {
      const rel = relative(root, abs);
      if (EXCLUDED_RELPATHS.has(rel)) continue;
      out.push(abs);
    }
  }
}

/**
 * Enumerate every in-scope file under `root`, as repo-relative paths.
 * Deterministic order (directory walk order, which readdir returns
 * alphabetically on the platforms we target) so reports diff cleanly.
 */
export function listScanTargets(root: string): string[] {
  const abs: string[] = [];
  for (const dir of SCAN_DIRS) {
    collectFiles(join(root, dir), root, abs);
  }
  for (const name of SCAN_ROOT_FILES) {
    const p = join(root, name);
    try {
      if (statSync(p).isFile()) abs.push(p);
    } catch {
      // absent root file is fine
    }
  }
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
