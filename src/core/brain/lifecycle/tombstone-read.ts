/** Read-only lifecycle state and supersession traversal. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { parseFrontmatter } from "../../vault.ts";
import { BRAIN_ROOT_REL, vaultRelative } from "../paths.ts";
import {
  MEMORY_FOLDERS,
  memoryFolderRel,
  memoryFromStore,
  storeMemoryPages,
} from "../memory-pages.ts";
import { BRAIN_TOMBSTONE_STATUS } from "../types.ts";

// ----- Constants ------------------------------------------------------------

/** On-disk frontmatter key holding a memory's operational status. */
export const LIFECYCLE_STATUS_KEY = "_status";
/** Normalized (un-prefixed) status key produced by `normalizeDerivedKeys`. */
export const LIFECYCLE_STATUS_KEY_NORMALIZED = "status";
/** Frontmatter key: ISO-8601 UTC second the tombstone was applied. */
export const TOMBSTONED_AT_KEY = "tombstoned_at";
/** Frontmatter key: operator-supplied tombstone reason. */
export const TOMBSTONE_REASON_KEY = "tombstone_reason";
/** Frontmatter key: wikilink to the successor that replaced this entry. */
export const SUPERSEDED_BY_KEY = "superseded_by";
/**
 * Hard cap on chain-walk depth. Guards against a pathological or
 * cyclic `superseded_by` graph turning {@link resolveChainTip} into an
 * unbounded loop; far beyond any realistic supersession depth.
 */
export const MAX_CHAIN_DEPTH = 64;

// ----- Lifecycle state ------------------------------------------------------

export interface LifecycleState {
  readonly tombstoned: boolean;
  /** ISO-8601 UTC second, or `null` when not tombstoned. */
  readonly tombstonedAt: string | null;
  readonly tombstoneReason: string | null;
  /** Normalized successor wikilink (`[[...]]`), or `null`. */
  readonly supersededBy: string | null;
}

export function readScalar(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read the lifecycle state carried by a raw frontmatter map (the output
 * of {@link parseFrontmatter}). Tolerant of both the `_status` on-disk
 * shape and the normalized `status` shape so it works whether the caller
 * passed raw or `normalizeDerivedKeys`-processed frontmatter.
 */
export function readLifecycleState(meta: Readonly<Record<string, unknown>>): LifecycleState {
  const status =
    readScalar(meta, LIFECYCLE_STATUS_KEY) ?? readScalar(meta, LIFECYCLE_STATUS_KEY_NORMALIZED);
  const tombstoned = status === BRAIN_TOMBSTONE_STATUS;
  return {
    tombstoned,
    tombstonedAt: readScalar(meta, TOMBSTONED_AT_KEY),
    tombstoneReason: readScalar(meta, TOMBSTONE_REASON_KEY),
    supersededBy: readScalar(meta, SUPERSEDED_BY_KEY),
  };
}

/**
 * True when a raw frontmatter map marks a tombstoned memory. This is the
 * shared exclusion predicate wired into recall / inject / active.md /
 * dream so a tombstoned (or superseded-non-tip, which is tombstoned with
 * a `superseded_by` pointer) entry stops appearing.
 */
export function isTombstoned(meta: Readonly<Record<string, unknown>>): boolean {
  return readLifecycleState(meta).tombstoned;
}

// ----- Link normalization ---------------------------------------------------

/**
 * Reduce a wikilink / bare id / basename to its bare identifier: strip
 * the `[[ ]]` fence and any `|alias` display suffix, then the `.md`
 * extension and directory components. Returns the trimmed identifier.
 */
export function normalizeChainLink(raw: string): string {
  let value = raw.trim();
  const fence = /^\[\[([^\]]+)\]\]$/.exec(value);
  if (fence) value = fence[1]!.trim();
  const pipe = value.indexOf("|");
  if (pipe >= 0) value = value.slice(0, pipe).trim();
  // Drop directory components and the markdown extension so a stored
  // vault-relative path and a bare basename resolve to the same node.
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (slash >= 0) value = value.slice(slash + 1);
  if (value.toLowerCase().endsWith(".md")) value = value.slice(0, -3);
  return value;
}

// ----- Chain resolution -----------------------------------------------------

export interface ChainLookupEntry {
  /** Successor wikilink / id, or `null` when this node is a tip. */
  readonly supersededBy: string | null;
}

/** Resolve a normalized node id to its chain entry, or `null` if unknown. */
export type ChainLookup = (link: string) => ChainLookupEntry | null;

export interface ResolveChainTipResult {
  /** Normalized identifier of the resolved tip. */
  readonly tip: string;
  /** Number of successor hops walked from the start. */
  readonly steps: number;
  /** True when a cycle short-circuited the walk. */
  readonly cycle: boolean;
  /**
   * True when every hop resolved to a known node. `false` when the walk
   * stopped at an id the lookup could not resolve (dangling successor).
   */
  readonly resolvedAll: boolean;
}

/**
 * Walk a chain of `superseded_by` links from `start` to its live tip.
 * Pure: the caller supplies the {@link ChainLookup}, so this is unit- and
 * property-testable without disk. Cycle- and depth-guarded.
 */
export function resolveChainTip(
  start: string,
  lookup: ChainLookup,
  opts: { readonly maxDepth?: number } = {},
): ResolveChainTipResult {
  const maxDepth = opts.maxDepth ?? MAX_CHAIN_DEPTH;
  const visited = new Set<string>();
  let current = normalizeChainLink(start);
  let steps = 0;
  visited.add(current);

  while (steps < maxDepth) {
    const entry = lookup(current);
    if (entry === null) {
      // Reached an id the lookup cannot resolve (unknown start or a
      // dangling successor): the walk stops at the last known node.
      return { tip: current, steps, cycle: false, resolvedAll: false };
    }
    if (entry.supersededBy === null || entry.supersededBy === "") {
      return { tip: current, steps, cycle: false, resolvedAll: true };
    }
    const next = normalizeChainLink(entry.supersededBy);
    if (visited.has(next)) {
      return { tip: current, steps, cycle: true, resolvedAll: true };
    }
    visited.add(next);
    current = next;
    steps++;
  }
  // Depth cap reached without terminating: treat as a pathological chain.
  return { tip: current, steps, cycle: true, resolvedAll: true };
}

/**
 * Build a {@link ChainLookup} over every markdown file under `Brain/`,
 * keyed by bare basename. Reads each file's frontmatter once. A node
 * that exists but carries no `superseded_by` resolves to a tip entry;
 * an unknown basename resolves to `null`. A page whose vault-relative
 * path `readable` refuses is not indexed at all, so it reads exactly as
 * an unknown basename; absent, every page is indexed.
 */
export function buildChainLookup(
  vault: string | null,
  readable?: (rel: string) => boolean,
): ChainLookup {
  const index = new Map<string, ChainLookupEntry>();
  // No vault: no pages on disk, only the store's.
  if (vault !== null) {
    const root = join(vault, BRAIN_ROOT_REL);
    // Once switched the memory pages are the store's: the frozen legacy
    // copies of those folders are not walked, so a page the store no
    // longer holds cannot keep resolving from a stale file.
    const skip = memoryFromStore(vault)
      ? new Set(MEMORY_FOLDERS.map((f) => join(vault, ...memoryFolderRel(f).split("/"))))
      : new Set<string>();
    if (existsSync(root)) walk(vault, root, index, readable, skip);
  }
  addStoredMemoryPages(vault, index, readable);
  return (link: string): ChainLookupEntry | null => index.get(normalizeChainLink(link)) ?? null;
}

/**
 * On a store-only machine the memory pages are records, not files (task
 * 2.10): index the pages the store's folds rebuild, under the same rules
 * as a file of the walk.
 */
function addStoredMemoryPages(
  vault: string | null,
  index: Map<string, ChainLookupEntry>,
  readable: ((rel: string) => boolean) | undefined,
): void {
  for (const folder of MEMORY_FOLDERS) {
    for (const page of storeMemoryPages(vault, folder) ?? []) {
      if (readable !== undefined && !readable(page.rel)) continue;
      const supersededBy = readScalar(page.read()[0], SUPERSEDED_BY_KEY);
      index.set(normalizeChainLink(page.name), { supersededBy });
    }
  }
}

function walk(
  vault: string,
  dir: string,
  index: Map<string, ChainLookupEntry>,
  readable: ((rel: string) => boolean) | undefined,
  skip: ReadonlySet<string>,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || skip.has(full)) continue;
      walk(vault, full, index, readable, skip);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    // Asked before the page is parsed, so a page the caller may not read
    // contributes nothing - not even its basename.
    if (readable !== undefined && !readable(vaultRelative(full, vault))) continue;
    let meta: FrontmatterMap;
    try {
      [meta] = parseFrontmatter(full);
    } catch {
      continue;
    }
    const id = normalizeChainLink(entry.name);
    const supersededBy = readScalar(meta, SUPERSEDED_BY_KEY);
    index.set(id, { supersededBy });
  }
}

/**
 * Convenience: resolve a chain tip against the live vault. Builds the
 * lookup from disk on each call - callers that resolve many tips in one
 * pass should reuse a {@link buildChainLookup} result via
 * {@link resolveChainTip} directly.
 */
export function resolveChainTipInVault(
  vault: string,
  start: string,
  opts: {
    readonly maxDepth?: number;
    /** The vault-relative paths the caller may read; see {@link buildChainLookup}. */
    readonly readable?: (rel: string) => boolean;
  } = {},
): ResolveChainTipResult {
  return resolveChainTip(start, buildChainLookup(vault, opts.readable), opts);
}
