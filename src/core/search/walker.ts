/**
 * Walk the vault, yielding `.md` files that should be indexed.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §6 edge cases
 * (symlinks, ignore list).
 *
 * v0.10.9: ignore decisions are delegated to
 * `src/core/vault-scope:matchIgnore` so the search indexer and
 * `scan-inline` share one policy. `parseIgnore` (CSV string ➝ set)
 * was removed in this version; `ResolvedSearchConfig.ignoreRules`
 * is already classified at config-resolution time.
 */

import { readdirSync, statSync, realpathSync, type Dirent, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

import { toPosix } from "../path-safety.ts";
import { matchIgnore } from "../vault-scope/index.ts";
import type { ResolvedSearchConfig } from "./types.ts";

export interface WalkedFile {
  /** Absolute path on disk. */
  readonly absPath: string;
  /** Vault-relative POSIX path. */
  readonly relPath: string;
  readonly stat: Stats;
}

function isInsideVault(absTarget: string, vaultReal: string): boolean {
  try {
    const r = realpathSync(absTarget);
    return r === vaultReal || r.startsWith(vaultReal + sep);
  } catch {
    return false;
  }
}

/**
 * Synchronous generator yielding every `.md` file under `config.vault`
 * (respecting `config.ignoreRules`). The caller drives the iteration so
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
  // Track real (canonical) paths of visited directories so a symlink
  // pointing back at an ancestor (or sibling) cannot send the walker
  // into an infinite loop. `isInsideVault` covers escape outside the
  // vault but is not acyclic on its own.
  const seenDirs = new Set<string>([vaultReal]);
  const rules = config.ignoreRules;

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
        if (matchIgnore(relPath, rules).excluded) continue;
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
      // File-level rule too: a `path/to/file.md` entry in
      // `vault.ignore_paths` excludes that exact file.
      if (matchIgnore(relPath, rules).excluded) continue;

      yield { absPath, relPath, stat };
    }
  }

  yield* walk(vaultReal);
}
