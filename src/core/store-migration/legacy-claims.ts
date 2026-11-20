/**
 * Which legacy files no mapping covers (task 2.2, design D11 step 4: an
 * unmapped surface fails the dry run).
 *
 * Every {@link Locator} claims the files it reads: a JSONL locator its
 * shard names, a page locator the `.md` files directly in its folder, a
 * tree locator its whole subtree. The walk then visits the two legacy
 * roots of a vault (`Brain/` and `.open-second-brain/`) and reports every
 * file or folder no claim covers, descending only into folders that hold
 * a claim further down. A sync tool's conflict copy is never a claimed
 * file: it belongs to the surface of the file it is a copy of
 * ({@link claimOfOriginal}, `sync-leftovers.ts` decides what becomes of
 * it), and is reported as unmapped only when no mapping claims that
 * file. A sync tool's in-flight temp file holds no data of its own and is
 * never reported. A `.lock`
 * sibling of a claimed file is claimed with it: it is the live lock of a
 * writer, recreated beside the file by its next writer, and holds no
 * data of its own.
 *
 * Read-only: it lists and stats, and never follows a link.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  isSyncConflictName,
  isSyncTempName,
  parseShardedName,
  syncConflictOriginalName,
} from "../brain/ledger-shards.ts";
import {
  isAtomicWriteTemp,
  LOCK_SIBLING_SUFFIX,
  lockSiblingOriginal,
  writerTempOriginals,
} from "../fs-atomic.ts";
import { isStoreFamilyEntry } from "../search/store-family.ts";
import { OS_METADATA_NAMES } from "../store/legacy-tree.ts";
import type { Locator } from "./destinations.ts";

/** One legacy entry no mapping claims. */
export interface UnmappedEntry {
  /** Vault-relative, with `/` separators. */
  readonly path: string;
  readonly type: "file" | "directory";
}

/** Whether `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The extensions a record-lane entry file carries, unless any file is one. */
export const ENTRY_EXTENSIONS: ReadonlyArray<string> = Object.freeze([".md", ".json"]);

/** The path and base name of the file a `.lock` sibling is the lock of. */
function lockTarget(path: string, name: string): [string, string] | null {
  const original = lockSiblingOriginal(name);
  if (original === null) return null;
  return [path.slice(0, -LOCK_SIBLING_SUFFIX.length), original];
}

function entryClaims(
  locator: Extract<Locator, { shape: "entries" }>,
  path: string,
  name: string,
): boolean {
  if (path === locator.root) return true; // a lane that is one file
  if (!within(path, locator.root) || isSyncConflictName(name) || isSyncTempName(name)) {
    return false;
  }
  // A writer's temp file beside the file it becomes is transient; a file
  // that only looks like one (nothing of the name it would become exists)
  // is the person's own and is read like any other.
  if (writerTempOf(path, name, (p, n) => entryClaims(locator, p, n))) return false;
  if (locator.anyFile !== true && !ENTRY_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return false;
  }
  const segments = relative(locator.root, path).split(sep);
  if (locator.lane === null && segments.length > 1 && segments[0]!.startsWith(".")) return false;
  return !(locator.exclude ?? []).some((other) => claims(other, path, name));
}

/**
 * Whether the file at `path` (base name `name`) is a temporary file one of
 * the product's writers renames onto a file beside it: a name of an
 * established writer convention (`fs-atomic.ts` `writerTempOriginals`)
 * whose target is on disk and is claimed (`isClaimed`). Such a file is
 * transient and holds no data of its own; a file that only has such a
 * name, with no target, is not one.
 */
export function writerTempOf(
  path: string,
  name: string,
  isClaimed: (path: string, name: string) => boolean,
): boolean {
  return writerTempOriginals(name).some((original) => {
    const target = join(dirname(path), original);
    return existsSync(target) && isClaimed(target, original);
  });
}

/**
 * Whether the file at `path` is transient: a writer's atomic temp file, a
 * sync tool's in-flight file, a writer's temp file beside a file a
 * mapping reads ({@link writerTempOf}), or a sync tool's conflict copy of
 * any of them. It is never imported and never an unmapped entry.
 */
export function isTransientLegacyFile(
  locators: ReadonlyArray<Locator>,
  path: string,
  name: string,
): boolean {
  if (isAtomicWriteTemp(name) || isSyncTempName(name)) return true;
  const claimed = (p: string, n: string): boolean => locators.some((l) => claims(l, p, n));
  if (writerTempOf(path, name, claimed)) return true;
  const original = syncConflictOriginalName(name);
  if (original === null || original === "" || original === name) return false;
  const originalPath = join(dirname(path), original);
  return (
    isAtomicWriteTemp(original) ||
    isSyncTempName(original) ||
    writerTempOf(originalPath, original, claimed)
  );
}

/** Whether `locator` reads the file at `path` (its base name `name`). */
export function claims(locator: Locator, path: string, name: string): boolean {
  switch (locator.shape) {
    case "entries":
      return entryClaims(locator, path, name);
    case "jsonl": {
      const parent = dirname(path);
      const dirOk = locator.subdirs ? dirname(parent) === locator.dir : parent === locator.dir;
      return dirOk && parseShardedName(name, locator.grammar) !== null;
    }
    case "pages":
      return dirname(path) === locator.dir && name.endsWith(".md") && !isSyncConflictName(name);
    case "json-files":
      return dirname(path) === locator.dir && name.endsWith(".json") && !isSyncConflictName(name);
    case "text":
      return path === locator.path;
    case "tree":
      if (locator.family === true) {
        return (
          dirname(path) === dirname(locator.path) &&
          isStoreFamilyEntry(name, basename(locator.path), false)
        );
      }
      if (locator.grammar === undefined) return within(path, locator.path);
      return dirname(path) === locator.path && parseShardedName(name, locator.grammar) !== null;
  }
}

/** The locator that claims the file of the copy, and whether only as a lock's sibling. */
export interface OriginalClaim {
  readonly locator: Locator;
  /** The original is the `.lock` sibling of the file `locator` claims: it holds no data. */
  readonly lock: boolean;
}

/**
 * The claim on the file a sync tool's conflict copy at `path` (base name
 * `name`) is a version of: the first of `locators` that reads that file,
 * or claims it as the lock sibling of a file it reads. Null when `name`
 * is no conflict copy, or when no mapping covers its original (the copy
 * is then an unmapped entry like any unknown file).
 */
export function claimOfOriginal(
  locators: ReadonlyArray<Locator>,
  path: string,
  name: string,
): OriginalClaim | null {
  const original = syncConflictOriginalName(name);
  if (original === null || original === "") return null;
  const originalPath = join(dirname(path), original);
  const direct = locators.find((locator) => claims(locator, originalPath, original));
  if (direct !== undefined) return { locator: direct, lock: false };
  const target = lockTarget(originalPath, original);
  if (target === null) return null;
  const held = locators.find((locator) => claims(locator, target[0], target[1]));
  return held === undefined ? null : { locator: held, lock: true };
}

/** The folder a locator reads from, for deciding where the walk descends. */
function anchor(locator: Locator): string {
  if (locator.shape === "entries") return locator.root;
  return locator.shape === "text" || locator.shape === "tree" ? locator.path : locator.dir;
}

/** Whether a folder has a non-folder entry anywhere below it. */
function holdsAFile(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return true; // unreadable: report it rather than hide it
  }
  return names.some((name) => {
    if (OS_METADATA_NAMES.has(name)) return false;
    const path = join(dir, name);
    try {
      return !lstatSync(path).isDirectory() || holdsAFile(path);
    } catch {
      return true;
    }
  });
}

/**
 * Every entry under `roots` that none of `locators` claims, with paths
 * relative to `vault`.
 */
export function unclaimedEntries(
  vault: string,
  roots: ReadonlyArray<string>,
  locators: ReadonlyArray<Locator>,
): UnmappedEntry[] {
  const anchors = locators.map(anchor);
  // A locator that reads every direct subfolder of its folder (one per
  // preference, per repository) needs the walk to enter each of them.
  const subdirParents = new Set(
    locators.flatMap((l) => (l.shape === "jsonl" && l.subdirs ? [l.dir] : [])),
  );
  // A lane-entry locator reads files at any depth below its root.
  const entryRoots = locators.flatMap((l) => (l.shape === "entries" ? [l.root] : []));
  const out: UnmappedEntry[] = [];
  const rel = (path: string): string => relative(vault, path).split(sep).join("/");

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).toSorted();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let isDir = false;
      try {
        isDir = lstatSync(path).isDirectory();
      } catch {
        continue;
      }
      if (!isDir && OS_METADATA_NAMES.has(name)) continue;
      // A writer's temp file, a sync tool's in-flight file and a conflict
      // copy of either hold no data of their own: the final delta pass
      // imports the file each becomes (`isTransientLegacyFile`).
      if (!isDir && isTransientLegacyFile(locators, path, name)) continue;
      if (!isDir && locators.some((locator) => claims(locator, path, name))) continue;
      if (!isDir && claimOfOriginal(locators, path, name) !== null) continue;
      if (isDir && locators.some((l) => l.shape === "tree" && claims(l, path, name))) continue;
      // A lock's sibling holds no data of its own, and the file it is the
      // lock of is recreated by its next writer: a live writer's lock on
      // a mapped surface (a worker lock, a metrics append) must not turn
      // the dry run's walk into an unmapped entry. A `.lock` whose target
      // nothing claims stays reported.
      const target = lockTarget(path, name);
      if (target !== null && locators.some((locator) => claims(locator, target[0], target[1]))) {
        continue;
      }
      const below = entryRoots.some((root) => within(path, root));
      if (isDir && (anchors.some((a) => within(a, path)) || subdirParents.has(dir) || below)) {
        walk(path);
        continue;
      }
      // A folder with no file anywhere below it holds no data to map.
      if (isDir && !holdsAFile(path)) continue;
      out.push({ path: rel(path), type: isDir ? "directory" : "file" });
    }
  };

  for (const root of roots) {
    try {
      if (!lstatSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(root);
  }
  return out;
}
