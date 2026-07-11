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
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteText } from "../fs-atomic.ts";

const INJECT_CACHE_DIR = ".open-second-brain";
const INJECT_CACHE_SUBDIR = "inject-cache";

function cachePath(vault: string, key: string): string {
  return join(vault, INJECT_CACHE_DIR, INJECT_CACHE_SUBDIR, `${key}.txt`);
}

/** Read the last-good injected body for `key`, or null when none/unreadable. */
export function readInjectCache(vault: string, key: string): string | null {
  const path = cachePath(vault, key);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Persist a last-good injected body. Best-effort: a write failure is swallowed. */
export function writeInjectCache(vault: string, key: string, body: string): void {
  try {
    atomicWriteText(cachePath(vault, key), body);
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
