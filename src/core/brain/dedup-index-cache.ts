/**
 * Machine-local cache of the signal dedup index (issue #195).
 *
 * `buildDedupIndex` reads the frontmatter of every `sig-*.md` in
 * `inbox/`, `inbox/processed/` and `inbox/archived/`. On a slow mount (WSL's
 * 9p view of a Windows drive) that is roughly 4 ms per file, and the set only
 * grows. This module persists what the walk learned so the next walk reads
 * only what changed.
 *
 * ## Validity
 *
 * The cache must stay correct when a sync tool (Syncthing) rewrites a file
 * under the same name, so it never trusts a file name alone. Two tiers:
 *
 *   1. DIRECTORY. A directory whose listing (count plus a digest of the
 *      sorted names) and own mtime are unchanged since a build that saw it
 *      QUIET is reused without touching its files. Every way a sync tool or
 *      this tool changes a signal file - create, delete, and the
 *      write-temp-then-rename a sync tool uses to replace one - changes the
 *      directory's mtime, so this tier never serves a replaced file.
 *   2. FILE. Otherwise each file is stat'ed and its entry reused when its
 *      size and mtime match the cached ones; any other file is re-read. A
 *      replaced file carries a different mtime (a sync tool stamps the
 *      remote side's), so it is re-read. The lookup is by file name across
 *      all three directories, so a signal the dream pass moved into the
 *      archive (a rename keeps size and mtime) is not re-read either.
 *
 * "Quiet" is git's racy-clean rule: a directory or file whose mtime is within
 * {@link RACY_WINDOW_MS} of the build is not trusted by the directory tier or
 * cached at all, because a write in the same timestamp tick would be
 * invisible to the comparison.
 *
 * What neither tier sees: an in-place edit of a signal's `dedup_hash` or `id`
 * frontmatter that keeps the directory listing, the directory mtime, the
 * file size and the file mtime all unchanged. Both fields are written once,
 * when the signal is created, by every writer in this repository.
 *
 * ## Location
 *
 * Outside the vault, under the user cache directory, keyed by a digest of
 * the vault's absolute path: stat data is per machine, and a cache inside a
 * synced vault would be rewritten from every machine in turn. It is listed
 * in the data-ownership statement (`OUT_OF_VAULT_STATE`,
 * `dedup_index_cache`). `OPEN_SECOND_BRAIN_DEDUP_CACHE_DIR` moves it;
 * `OPEN_SECOND_BRAIN_DEDUP_CACHE=0` turns it off.
 *
 * Every read and write here is best-effort: a missing, corrupt, foreign or
 * unwritable cache means a full walk, never a wrong index or a failure.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { APP_DIR_NAME, cacheBaseDir } from "../platform-dirs.ts";

/** Bumped whenever the file layout below changes; other versions are ignored. */
const CACHE_VERSION = 1;

/** A timestamp this close to the build is not trusted (racy-clean rule). */
export const RACY_WINDOW_MS = 2_000;

const CACHE_DIR_ENV = "OPEN_SECOND_BRAIN_DEDUP_CACHE_DIR";
const CACHE_SWITCH_ENV = "OPEN_SECOND_BRAIN_DEDUP_CACHE";
const CACHE_SUBDIR = "dedup-index";

/** One file's cached parse: stat identity plus the two fields the index needs. */
export interface CachedFileEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly hash: string | null;
  readonly id: string | null;
}

/** One directory's cached state. */
export interface CachedDirEntry {
  readonly mtimeMs: number;
  readonly count: number;
  readonly namesDigest: string;
  /** True when the build saw the directory outside the racy window. */
  readonly quiet: boolean;
  readonly files: Readonly<Record<string, CachedFileEntry>>;
}

export interface DedupIndexCacheData {
  readonly version: number;
  readonly vault: string;
  /** Keyed by the directory's absolute path. */
  readonly dirs: Readonly<Record<string, CachedDirEntry>>;
}

/**
 * Where this vault's cache lives, or null when caching is switched off.
 * Resolved per call so a test (or an operator) can move or disable it.
 */
export function dedupIndexCachePath(
  vault: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env[CACHE_SWITCH_ENV]?.trim() === "0") return null;
  const override = env[CACHE_DIR_ENV]?.trim();
  const dir = override ? override : join(cacheBaseDir(), APP_DIR_NAME, CACHE_SUBDIR);
  const key = createHash("sha256").update(resolve(vault)).digest("hex").slice(0, 32);
  return join(dir, `${key}.json`);
}

/** Digest of a directory listing, independent of enumeration order. */
export function namesDigest(names: ReadonlyArray<string>): string {
  return createHash("sha256").update(names.toSorted().join("\u0000")).digest("hex");
}

/** Read the cache for `vault`; null when absent, unreadable, foreign or stale-format. */
export function readDedupIndexCache(vault: string): DedupIndexCacheData | null {
  const path = dedupIndexCachePath(vault);
  if (path === null) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<DedupIndexCacheData>;
    if (data.version !== CACHE_VERSION) return null;
    // A digest collision or a copied cache directory must not hand one
    // vault another vault's index.
    if (data.vault !== resolve(vault)) return null;
    if (data.dirs === null || typeof data.dirs !== "object") return null;
    return data as DedupIndexCacheData;
  } catch {
    return null;
  }
}

/** Persist the cache; best-effort, never throws. */
export function writeDedupIndexCache(
  vault: string,
  dirs: Readonly<Record<string, CachedDirEntry>>,
): void {
  const path = dedupIndexCachePath(vault);
  if (path === null) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const data: DedupIndexCacheData = { version: CACHE_VERSION, vault: resolve(vault), dirs };
    atomicWriteFileSync(path, JSON.stringify(data));
  } catch {
    // A read-only home or a full disk costs the next caller a full walk.
  }
}
