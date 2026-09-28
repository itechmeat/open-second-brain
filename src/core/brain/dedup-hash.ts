/**
 * Content hash used by `o2b brain scan-inline` (§9) and `o2b brain
 * import-session` (§16) to dedup signals.
 *
 * The hash is computed over a normalised view of the signal payload —
 * topic, signal sign, principle, scope. Two payloads that describe
 * the same rule hash identically even when the source text differs
 * in cosmetic ways (Unicode normal form, whitespace, missing-vs-empty
 * scope). A real edit to `principle` (typo fix, rephrasing) changes
 * the hash — by design: the user re-stated the rule, treat it as a
 * fresh signal.
 *
 * `agent` is deliberately excluded. The same rule from two different
 * agents is still one rule; dream is what assigns provenance through
 * `evidenced_by`.
 *
 * Output: lowercase hex sha256 (64 chars).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatterText } from "../vault.ts";
import {
  namesDigest,
  RACY_WINDOW_MS,
  readDedupIndexCache,
  writeDedupIndexCache,
  type CachedDirEntry,
  type CachedFileEntry,
} from "./dedup-index-cache.ts";
import { brainDirs } from "./paths.ts";
import type { Safeguard } from "./safeguard.ts";
import { normalizeForDedup } from "./text/normalize.ts";

export interface DedupHashInput {
  readonly topic: string;
  readonly signal: "positive" | "negative";
  readonly principle: string;
  readonly scope?: string;
}

export interface DedupIndexEntry {
  readonly id: string;
  readonly path: string;
}

export interface DedupIndexOptions {
  /**
   * Sink for per-file read or parse failures. By default they are skipped
   * silently: the doctor surfaces malformed signals separately, and the
   * dedup builder is best-effort.
   */
  readonly onError?: (path: string, message: string) => void;
  /**
   * Cooperative deadline, checked per directory and per file. The walk is
   * synchronous I/O in {@link buildDedupIndex}, so a timer cannot cut it
   * short; this is how a hook with a host deadline stops it in time.
   */
  readonly safeguard?: Safeguard;
  /**
   * Read every file, trusting nothing from the cache. For a read-back that
   * must measure the disk rather than a record of it (the import census).
   */
  readonly fresh?: boolean;
}

export interface LoadDedupIndexOptions extends DedupIndexOptions {
  /** Parallel file operations for the async walk. Default 32. */
  readonly concurrency?: number;
}

const DEFAULT_CONCURRENCY = 32;

/**
 * Read-side complement of {@link computeDedupHash}. Walks `Brain/inbox/`,
 * `Brain/inbox/processed/` and `Brain/inbox/archived/`, and maps every
 * `sig-*.md`'s `dedup_hash` to its `{id, path}` (first seen wins, directories
 * in that order, files in listing order).
 *
 * The archive is included on purpose. It holds inbox signals the dream pass
 * archived because they left the contradiction window unconsumed; they used
 * to stay in the inbox for ever, and so in this index. Leaving them out would
 * let a re-imported old session re-create an archived signal as a fresh
 * inbox signal, which could then count toward a candidate it never earned.
 *
 * Shared by every capture path (inline scan, session import, session
 * lifecycle, fact extraction, the import census), so they cross-deduplicate.
 * The callers that write also mutate the returned map as they create
 * signals, which keeps it hot for the rest of their run.
 *
 * Revalidated against a machine-local cache (`dedup-index-cache.ts`), so a
 * rebuild reads only what changed. Synchronous; {@link loadDedupIndex} is
 * the same walk with parallel I/O, several times faster on a slow mount.
 */
export function buildDedupIndex(
  vault: string,
  opts: DedupIndexOptions = {},
): Map<string, DedupIndexEntry> {
  const started = Date.now();
  const plan = planWalk(vault, opts);
  for (const file of plan.toStat) {
    opts.safeguard?.checkpoint();
    statOne(file);
  }
  for (const file of plan.toParse()) {
    opts.safeguard?.checkpoint();
    parseOne(file, () => readFileSync(file.path, "utf8"), opts.onError);
  }
  return finishWalk(vault, plan, started);
}

/**
 * {@link buildDedupIndex} with the file stats and reads issued in parallel.
 * A slow mount is latency-bound rather than bandwidth-bound: measured on a
 * WSL 9p mount of a Windows drive, 4000 sequential reads took 16 s and the
 * same reads 32 at a time about 1.2 s. It also yields to the event loop, so
 * a process ceiling timer can fire while it runs.
 */
export async function loadDedupIndex(
  vault: string,
  opts: LoadDedupIndexOptions = {},
): Promise<Map<string, DedupIndexEntry>> {
  const started = Date.now();
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const plan = planWalk(vault, opts);
  await pool(plan.toStat, concurrency, opts.safeguard, async (file) => {
    try {
      const st = await stat(file.path);
      file.size = st.size;
      file.mtimeMs = st.mtimeMs;
    } catch {
      file.statFailed = true;
    }
  });
  await pool(plan.toParse(), concurrency, opts.safeguard, async (file) => {
    let text: string | null = null;
    try {
      text = await readFile(file.path, "utf8");
    } catch (err) {
      opts.onError?.(file.path, `dedup-index read failed: ${errorText(err)}`);
      return;
    }
    parseOne(file, () => text!, opts.onError);
  });
  return finishWalk(vault, plan, started);
}

// ----- walk internals ------------------------------------------------------

/** One signal file's state during a walk. */
interface WalkFile {
  readonly dir: string;
  readonly name: string;
  readonly path: string;
  size?: number;
  mtimeMs?: number;
  statFailed?: boolean;
  /** Set once the file's fields are known (from the cache or a parse). */
  entry?: CachedFileEntry;
}

interface WalkDir {
  readonly dir: string;
  readonly files: WalkFile[];
  readonly mtimeMs: number | null;
  readonly namesDigest: string;
  readonly fast: boolean;
}

interface WalkPlan {
  readonly dirs: WalkDir[];
  /** Files that need a stat before the cache can vouch for them. */
  readonly toStat: WalkFile[];
  /** Files still unresolved after the stats; computed lazily. */
  toParse(): WalkFile[];
}

function planWalk(vault: string, opts: DedupIndexOptions): WalkPlan {
  const { safeguard } = opts;
  const bd = brainDirs(vault);
  const cache = opts.fresh === true ? null : readDedupIndexCache(vault);
  // Every cached file entry by name, whichever directory it was in: a
  // rename between the three directories keeps size and mtime, so a file
  // the dream pass moved into the archive is reused rather than re-read.
  const byName = new Map<string, CachedFileEntry>();
  if (cache !== null) {
    for (const d of Object.values(cache.dirs)) {
      for (const [name, e] of Object.entries(d.files ?? {})) byName.set(name, e);
    }
  }
  const dirs: WalkDir[] = [];
  const toStat: WalkFile[] = [];
  for (const dir of [bd.inbox, bd.processed, bd.archived]) {
    safeguard?.checkpoint();
    if (!existsSync(dir)) continue;
    let names: string[];
    let mtimeMs: number | null = null;
    try {
      names = readdirSync(dir).filter((n) => n.startsWith("sig-") && n.endsWith(".md"));
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const digest = namesDigest(names);
    const cached = cache?.dirs[dir];
    const fast =
      cached !== undefined &&
      cached.quiet === true &&
      cached.mtimeMs === mtimeMs &&
      cached.count === names.length &&
      cached.namesDigest === digest &&
      names.every((n) => cached.files[n] !== undefined);
    const files: WalkFile[] = names.map((name) => ({ dir, name, path: join(dir, name) }));
    if (fast) {
      for (const f of files) f.entry = cached.files[f.name]!;
    } else {
      toStat.push(...files);
    }
    dirs.push({ dir, files, mtimeMs, namesDigest: digest, fast });
  }
  return {
    dirs,
    toStat,
    toParse: () =>
      toStat.filter((f) => {
        if (f.statFailed === true || f.size === undefined) return true;
        const hit = byName.get(f.name);
        if (hit !== undefined && hit.size === f.size && hit.mtimeMs === f.mtimeMs) {
          f.entry = hit;
          return false;
        }
        return true;
      }),
  };
}

function statOne(file: WalkFile): void {
  try {
    const st = statSync(file.path);
    file.size = st.size;
    file.mtimeMs = st.mtimeMs;
  } catch {
    file.statFailed = true;
  }
}

function parseOne(file: WalkFile, read: () => string, onError: DedupIndexOptions["onError"]): void {
  try {
    const [meta] = parseFrontmatterText(read());
    const hash = meta["dedup_hash"];
    const id = meta["id"];
    // A file whose stat failed gets -1, which is never cached (see
    // `finishWalk`), so the next build reads it again.
    file.entry = {
      size: file.size ?? -1,
      mtimeMs: file.mtimeMs ?? -1,
      hash: typeof hash === "string" && hash.length > 0 ? hash : null,
      id: typeof id === "string" ? id : null,
    };
  } catch (err) {
    onError?.(file.path, `dedup-index parse failed: ${errorText(err)}`);
  }
}

function finishWalk(vault: string, plan: WalkPlan, started: number): Map<string, DedupIndexEntry> {
  const out = new Map<string, DedupIndexEntry>();
  const nextDirs: Record<string, CachedDirEntry> = {};
  const racyFloor = started - RACY_WINDOW_MS;
  let changed = false;
  for (const d of plan.dirs) {
    const cachedFiles: Record<string, CachedFileEntry> = {};
    for (const f of d.files) {
      const e = f.entry;
      if (e === undefined) continue;
      if (e.hash !== null && e.id !== null && !out.has(e.hash)) {
        out.set(e.hash, { id: e.id, path: f.path });
      }
      // Racy-clean: an entry whose mtime is this close to the build could
      // hide a same-tick rewrite, so it is not carried into the cache.
      if (e.size < 0 || e.mtimeMs < 0 || e.mtimeMs > racyFloor) continue;
      cachedFiles[f.name] = e;
    }
    if (!d.fast) changed = true;
    nextDirs[d.dir] = {
      mtimeMs: d.mtimeMs ?? -1,
      count: d.files.length,
      namesDigest: d.namesDigest,
      quiet: d.mtimeMs !== null && d.mtimeMs <= racyFloor && dirUnchanged(d),
      files: cachedFiles,
    };
  }
  if (changed) writeDedupIndexCache(vault, nextDirs);
  return out;
}

/** Whether the directory is still as the walk first saw it. */
function dirUnchanged(d: WalkDir): boolean {
  try {
    return statSync(d.dir).mtimeMs === d.mtimeMs;
  } catch {
    return false;
  }
}

/** Run `task` over `items` with at most `limit` in flight; stops on the first error. */
async function pool<T>(
  items: ReadonlyArray<T>,
  limit: number,
  safeguard: Safeguard | undefined,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        safeguard?.checkpoint();
        // oxlint-disable-next-line no-await-in-loop -- a bounded worker pool, sequential per worker by design
        await task(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function computeDedupHash(input: DedupHashInput): string {
  // Use NUL as the field separator so a topic / principle containing
  // any printable character can't collide with the next field's prefix.
  const parts = [
    normalizeForDedup(input.topic.trim()),
    input.signal,
    normalizeForDedup(input.principle.trim().replace(/\s+/g, " ")),
    normalizeForDedup((input.scope ?? "").trim()),
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}
