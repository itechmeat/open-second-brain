/**
 * Fail-open context load for lifecycle-hook injection.
 *
 * When session-start context assembly overruns or throws (a slow embedding,
 * a stuck reindex, a filesystem stall), the inject path must degrade to the
 * last-good context or an empty context - never error noisily and never emit
 * a partial or poisoned payload. This module wraps an assembler with that
 * guarantee and keeps a durable last-good snapshot under the machine-local
 * `.open-second-brain/inject-cache/` directory.
 *
 * A successful non-empty assembly is written to the cache. A legitimately
 * empty assembly (nothing to inject this session) is NOT cached, so it never
 * clobbers a good snapshot a later error would degrade to. Only a thrown
 * assembly degrades, and it audits exactly once.
 *
 * The cache directory sits inside the vault, so a symbolic link on the way
 * to it (`.open-second-brain` or `inject-cache`) is refused: nothing is read
 * from or written through it, and a cache file that is itself a link is not
 * followed (see `derived-store-guard.ts`).
 */

import { join } from "node:path";

import { derivedDirIsSymlinked, readRegularFileNoFollow } from "../derived-store-guard.ts";
import { atomicWriteText } from "../fs-atomic.ts";
import { machineStateRoot } from "../state/machine-state.ts";

const INJECT_CACHE_DIR = ".open-second-brain";
const INJECT_CACHE_SUBDIR = "inject-cache";

/**
 * The cache directory's root: the vault, or the device-local state once
 * switched (`state/machine-state.ts`). Resolved once per call and inside a
 * catch, so a fault resolving it costs the cache, never the inject path.
 */
function cacheRoot(vault: string): string | null {
  try {
    return machineStateRoot(vault);
  } catch {
    return null;
  }
}

/**
 * Read the last-good injected body for `key`, or null when none, unreadable,
 * not a regular file, or behind a symlinked cache directory.
 */
export function readInjectCache(vault: string, key: string): string | null {
  const root = cacheRoot(vault);
  if (root === null || derivedDirIsSymlinked(root, INJECT_CACHE_DIR, INJECT_CACHE_SUBDIR)) {
    return null;
  }
  const read = readRegularFileNoFollow(
    join(root, INJECT_CACHE_DIR, INJECT_CACHE_SUBDIR, `${key}.txt`),
  );
  return read.status === "ok" ? read.text : null;
}

/**
 * Persist a last-good injected body with mode 0600. Best-effort: a write
 * failure is swallowed, and a symlinked cache directory skips the write.
 */
export function writeInjectCache(vault: string, key: string, body: string): void {
  try {
    const root = cacheRoot(vault);
    if (root === null || derivedDirIsSymlinked(root, INJECT_CACHE_DIR, INJECT_CACHE_SUBDIR)) return;
    atomicWriteText(join(root, INJECT_CACHE_DIR, INJECT_CACHE_SUBDIR, `${key}.txt`), body, {
      mode: 0o600,
    });
  } catch {
    // The cache is an optimization; a failure to persist must never disturb
    // the inject path.
  }
}

/** Where a degrade landed: a fresh assembly, the cached last-good, or empty. */
export type InjectContextSource = "fresh" | "cached" | "empty";

export interface FailOpenResult {
  readonly context: string;
  readonly degraded: boolean;
  readonly source: InjectContextSource;
}

export interface LoadInjectContextOptions {
  readonly vault: string;
  /** Cache key (e.g. the hook/surface name). */
  readonly key: string;
  /** Assembles the injected context. May be sync or async; may throw. */
  readonly assemble: () => string | Promise<string>;
  /** Called once when the load degrades (source: cached | empty). */
  readonly audit?: (source: Exclude<InjectContextSource, "fresh">, error: unknown) => void;
}

/**
 * Run `assemble` fail-open. On success return the assembled context (caching
 * it when non-empty). On any throw degrade to the last-good cache, or to empty
 * when no cache exists, auditing the degrade once.
 */
export async function loadInjectContextFailOpen(
  opts: LoadInjectContextOptions,
): Promise<FailOpenResult> {
  try {
    const context = await opts.assemble();
    if (context.length > 0) {
      writeInjectCache(opts.vault, opts.key, context);
    }
    return { context, degraded: false, source: "fresh" };
  } catch (error) {
    const cached = readInjectCache(opts.vault, opts.key);
    if (cached !== null && cached.length > 0) {
      opts.audit?.("cached", error);
      return { context: cached, degraded: true, source: "cached" };
    }
    opts.audit?.("empty", error);
    return { context: "", degraded: true, source: "empty" };
  }
}
