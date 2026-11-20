/**
 * Walk the vault, yielding `.md` files that should be indexed.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §6 edge cases
 * (symlinks, ignore list).
 *
 * v0.10.9: scope decisions are delegated to `src/core/vault-scope` so
 * the search indexer and `scan-inline` share one policy. `parseIgnore`
 * (CSV string ➝ set) was removed in this version;
 * `ResolvedSearchConfig.scopeRules` is already classified at
 * config-resolution time.
 *
 * v1.46.0: the same delegation now carries the positive
 * `vault.include_paths` allowlist. Files are gated with `matchScope`
 * and directories with `mayDescend`, which are different questions - a
 * directory that holds no included file may still be the only route to
 * a declared root.
 */

import { readdirSync, statSync, realpathSync, type Dirent, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { canonicalNotePath } from "../path-safety.ts";
import { storeOnlyMode } from "../store/store-only.ts";
import { admitToIndex } from "../vault-scope/index-admission.ts";
import { matchScope, mayDescend } from "../vault-scope/index.ts";
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
 * Whether the vault's legacy `Brain/` tree is an archive the index leaves
 * out: this machine switched to the brain store its index reads, so the
 * signals, preferences and log there are records of the store, indexed as
 * such, and the tree only waits for `o2b brain migrate-store
 * --remove-legacy` to move it out of the vault. Indexed as notes it
 * answered every migrated item twice and, with the log day pages, made the
 * index twice the size. A vault that never migrated (or a store-only
 * machine that never had a legacy brain) keeps its `Brain/` pages. A
 * machine whose switch cannot be read is taken as not switched.
 */
export function legacyTreeArchived(config: ResolvedSearchConfig): boolean {
  if (config.vault === null || config.brainStore === null || config.brainStore === undefined) {
    return false;
  }
  try {
    return (
      storeOnlyMode({
        vault: config.vault,
        ...(config.configPath !== null ? { configPath: config.configPath } : {}),
      }).reason === "device-switched"
    );
  } catch {
    return false;
  }
}

/**
 * Synchronous generator yielding every `.md` file under `config.vault`
 * (respecting `config.scopeRules`). The caller drives the iteration so
 * the indexer can pipeline reads + writes without buffering the whole
 * tree.
 */
export function* walkVault(config: ResolvedSearchConfig): Generator<WalkedFile> {
  // No vault (design D14): there are no notes to walk; the index holds the
  // brain store's records only.
  const vault = config.vault;
  if (vault === null) return;
  const vaultReal = (() => {
    try {
      return realpathSync(vault);
    } catch {
      return vault;
    }
  })();
  // Track real (canonical) paths of visited directories so a symlink
  // pointing back at an ancestor (or sibling) cannot send the walker
  // into an infinite loop. `isInsideVault` covers escape outside the
  // vault but is not acyclic on its own.
  const seenDirs = new Set<string>([vaultReal]);
  const rules = config.scopeRules;
  // The legacy tree of a switched machine, by its canonical path: the
  // vault's top-level `Brain/` folder.
  const skipBrainRoot = legacyTreeArchived(config);
  // Its real path too: a link elsewhere in the vault that resolves into
  // the archived tree (a folder or a single page) is the archive as well.
  const brainReal = skipBrainRoot
    ? (() => {
        try {
          return realpathSync(join(vaultReal, BRAIN_ROOT_REL));
        } catch {
          return null;
        }
      })()
    : null;
  const inArchive = (real: string): boolean =>
    brainReal !== null && (real === brainReal || real.startsWith(brainReal + sep));

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
      // Canonical note identity (POSIX + NFC). `absPath` stays in the
      // on-disk form for I/O (APFS lookup is normalisation-insensitive),
      // but the vault-relative key that identifies the note - matched
      // against the stored index path and against ignore rules - must be
      // one value across a macOS (NFD) / Linux (NFC) Syncthing peer set.
      const relPath = canonicalNotePath(relPathRaw);

      const isLinkHint = entry.isSymbolicLink();

      let stat: Stats;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Descent, not membership: an allowlist root may live below a
        // directory that holds no included file of its own.
        if (!mayDescend(relPath, rules)) continue;
        if (skipBrainRoot && relPath === BRAIN_ROOT_REL) continue;
        // Index-admission predicate (seam 2): skip descending into an
        // excluded lane directory (e.g. the exact-state lane) entirely.
        if (!admitToIndex(relPath).admit) continue;
        let dirReal: string;
        try {
          dirReal = realpathSync(absPath);
        } catch {
          continue;
        }
        if (dirReal !== vaultReal && !dirReal.startsWith(vaultReal + sep)) continue;
        if (inArchive(dirReal)) continue;
        if (seenDirs.has(dirReal)) continue;
        seenDirs.add(dirReal);
        yield* walk(absPath);
        continue;
      }

      if (!stat.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (isLinkHint && !isInsideVault(absPath, vaultReal)) continue;
      if (isLinkHint && brainReal !== null) {
        let fileReal: string;
        try {
          fileReal = realpathSync(absPath);
        } catch {
          continue;
        }
        if (inArchive(fileReal)) continue;
      }
      // File-level rule too: a `path/to/file.md` entry in
      // `vault.ignore_paths` excludes that exact file, and a declared
      // `vault.include_paths` admits only what it names.
      if (!matchScope(relPath, rules).inScope) continue;
      // Index-admission predicate (seam 2): the exact-state lane and any
      // other lane-owned artifact never enters the index. Defaults to
      // admit, so all existing non-lane content is yielded unchanged.
      if (!admitToIndex(relPath).admit) continue;

      yield { absPath, relPath, stat };
    }
  }

  yield* walk(vaultReal);
}
