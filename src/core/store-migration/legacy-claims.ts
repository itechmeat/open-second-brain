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
 * file: it is reported as unmapped, to be merged by hand.
 *
 * Read-only: it lists and stats, and never follows a link.
 */

import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { isSyncConflictName, parseShardedName } from "../brain/ledger-shards.ts";
import { isAtomicWriteTemp } from "../fs-atomic.ts";
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

function entryClaims(
  locator: Extract<Locator, { shape: "entries" }>,
  path: string,
  name: string,
): boolean {
  if (path === locator.root) return true; // a lane that is one file
  if (!within(path, locator.root) || isSyncConflictName(name)) return false;
  if (locator.anyFile !== true && !ENTRY_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return false;
  }
  const segments = relative(locator.root, path).split(sep);
  if (locator.lane === null && segments.length > 1 && segments[0]!.startsWith(".")) return false;
  return !(locator.exclude ?? []).some((other) => claims(other, path, name));
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
      if (locator.grammar === undefined) return within(path, locator.path);
      return dirname(path) === locator.path && parseShardedName(name, locator.grammar) !== null;
  }
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
      // A writer's atomic temp file holds no data of its own: the final
      // delta pass imports the file it becomes.
      if (!isDir && isAtomicWriteTemp(name)) continue;
      if (!isDir && locators.some((locator) => claims(locator, path, name))) continue;
      if (isDir && locators.some((l) => l.shape === "tree" && claims(l, path, name))) continue;
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
