/**
 * Walk the vault, yielding `.md` files that should be indexed.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §6 edge cases
 * (symlinks, ignore list).
 */

import { readdirSync, statSync, realpathSync, type Dirent, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

import type { ResolvedSearchConfig } from "./types.ts";

export interface WalkedFile {
  /** Absolute path on disk. */
  readonly absPath: string;
  /** Vault-relative POSIX path. */
  readonly relPath: string;
  readonly stat: Stats;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Parse the ignore list into two sets:
 *
 *   - bare names (no `/`) match a directory whose name equals the entry
 *     anywhere in the tree;
 *   - relative paths match the vault-relative directory exactly.
 */
function parseIgnore(ignorePaths: ReadonlyArray<string>): {
  names: Set<string>;
  relPaths: Set<string>;
} {
  const names = new Set<string>();
  const relPaths = new Set<string>();
  for (const raw of ignorePaths) {
    const e = raw.trim();
    if (e === "") continue;
    if (e.includes("/")) relPaths.add(e);
    else names.add(e);
  }
  return { names, relPaths };
}

function isInsideVault(absTarget: string, vaultReal: string): boolean {
  const targetReal = (() => {
    try {
      return realpathSync(absTarget);
    } catch {
      return null;
    }
  })();
  if (targetReal === null) return false;
  return targetReal === vaultReal || targetReal.startsWith(vaultReal + sep);
}

/**
 * Synchronous generator yielding every `.md` file under `config.vault`
 * (respecting `config.ignorePaths`). The caller drives the iteration so
 * the indexer can pipeline reads + writes without buffering the whole
 * tree.
 */
export function* walkVault(config: ResolvedSearchConfig): Generator<WalkedFile> {
  const vaultReal = (() => {
    try {
      return realpathSync(config.vault);
    } catch {
      return config.vault;
    }
  })();
  const { names, relPaths } = parseIgnore(config.ignorePaths);
  // Track real (canonical) paths of visited directories so a symlink
  // pointing back at an ancestor (or sibling) cannot send the walker
  // into an infinite loop. `isInsideVault` covers escape outside the
  // vault but is not acyclic on its own.
  const seenDirs = new Set<string>([vaultReal]);

  function* walk(dir: string): Generator<WalkedFile> {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" }) as Dirent[];
    } catch {
      return;
    }
    // Sort by name so two identical vaults produce the same traversal
    // order across filesystems and platforms — important for the
    // deterministic-indexing contract and for stable Syncthing peers.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      const relPathRaw = relative(vaultReal, absPath);
      if (relPathRaw === "" || relPathRaw.startsWith("..")) continue;
      const relPath = toPosix(relPathRaw);

      const isLinkHint = entry.isSymbolicLink();

      let stat: Stats;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (names.has(entry.name)) continue;
        if (relPaths.has(relPath)) continue;
        let dirReal: string;
        try {
          dirReal = realpathSync(absPath);
        } catch {
          continue;
        }
        if (dirReal !== vaultReal && !dirReal.startsWith(vaultReal + sep)) continue;
        if (seenDirs.has(dirReal)) continue;
        seenDirs.add(dirReal);
        yield* walk(absPath);
        continue;
      }

      if (!stat.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (isLinkHint && !isInsideVault(absPath, vaultReal)) continue;

      yield { absPath, relPath, stat };
    }
  }

  yield* walk(vaultReal);
}
