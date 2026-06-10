/**
 * Anticipatory Brain context cache
 * (continuity-hygiene-freshness suite; kanban t_4cee9df5).
 *
 * Prepare the next turn's memory evidence while the agent is still
 * working, instead of waiting for an explicit search. Lifecycle hook
 * events (prompt submit, tool use) refresh a small context bundle -
 * the active context pack plus session-recall hits for the latest
 * signal text - debounced by a TTL with an injected clock, written
 * atomically under `Brain/.state/anticipatory/`, and keyed by the
 * session's lineage root so one conversation keeps one cache across
 * compression boundaries.
 *
 * Hard constraints honored here: NO daemon and NO file watcher
 * (refresh piggybacks on events that already fire), and fail-soft
 * everywhere - a broken cache is a miss, never an error that could
 * block a hook.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { packContext, type ContextPackItem } from "./context-pack.ts";
import { readLineageLedger } from "./lineage/ledger.ts";
import { resolveSessionLineage } from "./lineage/resolve.ts";
import { BRAIN_ROOT_REL, ensureInsideVault } from "./paths.ts";
import { searchSessionRecall, type SessionRecallHit } from "./session-recall.ts";

export const ANTICIPATORY_SCHEMA_VERSION = "o2b.anticipatory.v1";

/** Default debounce/freshness window. */
export const DEFAULT_ANTICIPATORY_TTL_SECONDS = 120;
/** Default token budget for the cached context pack. */
export const DEFAULT_ANTICIPATORY_MAX_TOKENS = 2_000;
const DEFAULT_SESSION_HITS = 5;

const CACHE_DIR_REL = posix.join(BRAIN_ROOT_REL, ".state", "anticipatory");

export interface AnticipatoryContext {
  readonly items: ReadonlyArray<ContextPackItem>;
  readonly session_hits: ReadonlyArray<SessionRecallHit>;
}

export interface RefreshAnticipatoryCacheInput {
  readonly sessionId: string;
  /** Latest user-visible signal (prompt text) steering the bundle. */
  readonly signalText?: string;
  /** Injected clock - hooks pass their event time. */
  readonly now: Date;
  readonly ttlSeconds?: number;
  readonly maxTokens?: number;
}

export interface RefreshAnticipatoryCacheResult {
  readonly refreshed: boolean;
  readonly rootSessionId: string;
  readonly path: string;
}

export type AnticipatoryCacheState = "warm" | "stale" | "miss";

export interface ReadAnticipatoryContextInput {
  readonly sessionId: string;
  readonly now: Date;
  readonly ttlSeconds?: number;
  readonly maxTokens?: number;
}

export interface ReadAnticipatoryContextResult {
  readonly cache_state: AnticipatoryCacheState;
  readonly root_session_id: string;
  /** Stamp of the cache that answered (warm reads only). */
  readonly generated_at?: string;
  readonly context: AnticipatoryContext;
}

interface CacheFile {
  readonly schema: string;
  readonly root_session_id: string;
  readonly session_id: string;
  readonly generated_at: string;
  readonly signal?: string;
  readonly context: AnticipatoryContext;
}

/** Replace every path-hostile code point so any session id maps to one flat filename. */
function safeCacheKey(rootId: string): string {
  const safe = rootId.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe.length > 0 ? safe.slice(0, 120) : "_";
}

export function anticipatoryCachePath(vault: string, rootSessionId: string): string {
  return ensureInsideVault(
    join(vault, CACHE_DIR_REL, `${safeCacheKey(rootSessionId)}.json`),
    vault,
  );
}

function resolveRootId(vault: string, sessionId: string): string {
  try {
    return resolveSessionLineage({ sessionId }, { ledger: readLineageLedger(vault) }).rootId;
  } catch {
    return sessionId;
  }
}

function readCacheFile(path: string): CacheFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const cache = parsed as CacheFile;
    if (cache.schema !== ANTICIPATORY_SCHEMA_VERSION) return null;
    if (typeof cache.generated_at !== "string") return null;
    if (cache.context === null || typeof cache.context !== "object") return null;
    if (!Array.isArray(cache.context.items) || !Array.isArray(cache.context.session_hits)) {
      return null;
    }
    return cache;
  } catch {
    return null; // corrupt cache reads as a miss by contract
  }
}

function buildContext(
  vault: string,
  sessionId: string,
  signalText: string | undefined,
  maxTokens: number,
): AnticipatoryContext {
  const pack = packContext(vault, { maxTokens });
  const signal = signalText?.trim() ?? "";
  const hits =
    signal.length > 0
      ? searchSessionRecall(vault, { query: signal, sessionId, limit: DEFAULT_SESSION_HITS }).hits
      : Object.freeze([] as SessionRecallHit[]);
  return Object.freeze({ items: pack.items, session_hits: hits });
}

/**
 * Refresh the cache for the session's lineage root unless a fresh copy
 * already exists (TTL debounce). Never throws.
 */
export function refreshAnticipatoryCache(
  vault: string,
  input: RefreshAnticipatoryCacheInput,
): RefreshAnticipatoryCacheResult {
  const rootId = resolveRootId(vault, input.sessionId);
  const path = anticipatoryCachePath(vault, rootId);
  const ttlMs = (input.ttlSeconds ?? DEFAULT_ANTICIPATORY_TTL_SECONDS) * 1_000;
  try {
    const existing = readCacheFile(path);
    if (existing !== null) {
      const age = input.now.getTime() - Date.parse(existing.generated_at);
      if (Number.isFinite(age) && age >= 0 && age < ttlMs) {
        return Object.freeze({ refreshed: false, rootSessionId: rootId, path });
      }
    }
    const context = buildContext(
      vault,
      input.sessionId,
      input.signalText,
      input.maxTokens ?? DEFAULT_ANTICIPATORY_MAX_TOKENS,
    );
    const signal = input.signalText?.trim();
    const cache: CacheFile = {
      schema: ANTICIPATORY_SCHEMA_VERSION,
      root_session_id: rootId,
      session_id: input.sessionId,
      generated_at: input.now.toISOString(),
      ...(signal !== undefined && signal.length > 0 ? { signal } : {}),
      context,
    };
    mkdirSync(join(vault, CACHE_DIR_REL), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
    return Object.freeze({ refreshed: true, rootSessionId: rootId, path });
  } catch {
    return Object.freeze({ refreshed: false, rootSessionId: rootId, path });
  }
}

/**
 * Read the warm cache for the session's lineage root, falling back to
 * a live bundle on miss or staleness. Never throws.
 */
export function readAnticipatoryContext(
  vault: string,
  input: ReadAnticipatoryContextInput,
): ReadAnticipatoryContextResult {
  const rootId = resolveRootId(vault, input.sessionId);
  const path = anticipatoryCachePath(vault, rootId);
  const ttlMs = (input.ttlSeconds ?? DEFAULT_ANTICIPATORY_TTL_SECONDS) * 1_000;
  const cached = readCacheFile(path);
  if (cached !== null) {
    const age = input.now.getTime() - Date.parse(cached.generated_at);
    if (Number.isFinite(age) && age >= 0 && age < ttlMs) {
      return Object.freeze({
        cache_state: "warm" as const,
        root_session_id: rootId,
        generated_at: cached.generated_at,
        context: cached.context,
      });
    }
    return Object.freeze({
      cache_state: "stale" as const,
      root_session_id: rootId,
      context: buildContext(
        vault,
        input.sessionId,
        cached.signal,
        input.maxTokens ?? DEFAULT_ANTICIPATORY_MAX_TOKENS,
      ),
    });
  }
  return Object.freeze({
    cache_state: "miss" as const,
    root_session_id: rootId,
    context: buildContext(
      vault,
      input.sessionId,
      undefined,
      input.maxTokens ?? DEFAULT_ANTICIPATORY_MAX_TOKENS,
    ),
  });
}
