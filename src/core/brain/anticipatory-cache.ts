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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import type { StampTokens } from "../integrity/stamp.ts";
import { packContext, type ContextPackItem } from "./context-pack.ts";
import { readLineageLedger } from "./lineage/ledger.ts";
import { packStampRefusal, packStampTokens, type ContextPackStamp } from "./pack-stamp.ts";
import { resolveOwnerScopeDelivery } from "./preferences-collect.ts";
import { resolveSessionLineage } from "./lineage/resolve.ts";
import { BRAIN_ROOT_REL, ensureInsideVault } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { searchSessionRecall, type SessionRecallHit } from "./session-recall.ts";

/**
 * Cache-file schema token. Bumped to `v2` by context-integrity-gates
 * (Unit B) because a `v1` file carries no provenance stamp: reusing the
 * version would leave those entries readable as UNSTAMPED hits, which is
 * exactly the "trusted forever" state the stamp exists to remove.
 * `readCacheFile` already rejects a schema mismatch, so the bump needs no
 * migration - every pre-existing file simply reads as a miss and is
 * rebuilt on the next refresh.
 */
export const ANTICIPATORY_SCHEMA_VERSION = "o2b.anticipatory.v2";

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
  /**
   * Owner scope for delivery isolation (context-integrity-gates, Unit
   * A). Part of the cache IDENTITY, not just the pack build: a bundle
   * assembled under one scope must never be served under another, which
   * a path keyed only on the lineage root would allow between two agents
   * sharing one conversation lineage.
   */
  readonly agentScope?: string;
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
  /**
   * Owner scope for delivery isolation (context-integrity-gates, Unit
   * A). Part of the cache IDENTITY, not just the pack build: a bundle
   * assembled under one scope must never be served under another, which
   * a path keyed only on the lineage root would allow between two agents
   * sharing one conversation lineage.
   */
  readonly agentScope?: string;
}

export interface ReadAnticipatoryContextResult {
  readonly cache_state: AnticipatoryCacheState;
  readonly root_session_id: string;
  /** Stamp of the cache that answered (warm reads only). */
  readonly generated_at?: string;
  /**
   * Why an otherwise-fresh cache entry was REFUSED rather than served
   * (context-integrity-gates, Unit B): its provenance stamp drifted from
   * the vault, or its validity window closed. Present only on a refusal,
   * so an ordinary miss or a TTL-stale read stays byte-identical. The
   * refusal is named rather than silent precisely so a stale bundle and
   * a broken mechanism stay distinguishable.
   */
  readonly cache_refusal?: string;
  readonly context: AnticipatoryContext;
}

/** On-disk form of {@link ContextPackStamp} (snake_case, like its siblings). */
interface CacheStamp {
  readonly tokens: Record<string, string | null>;
  readonly generated_at: string;
  readonly expires_at: string;
}

interface CacheFile {
  readonly schema: string;
  readonly root_session_id: string;
  readonly session_id: string;
  readonly generated_at: string;
  /** Token budget the cached pack was built under (variant field). */
  readonly max_tokens: number;
  readonly signal?: string;
  /** What the cached pack was derived from, and when it stops being servable. */
  readonly stamp: CacheStamp;
  readonly context: AnticipatoryContext;
}

function toCacheStamp(stamp: ContextPackStamp): CacheStamp {
  return {
    tokens: { ...stamp.tokens },
    generated_at: stamp.generatedAt,
    expires_at: stamp.expiresAt,
  };
}

function fromCacheStamp(stamp: CacheStamp): ContextPackStamp {
  return {
    tokens: stamp.tokens as StampTokens,
    generatedAt: stamp.generated_at,
    expiresAt: stamp.expires_at,
  };
}

/**
 * Collision-resistant flat filename for any root id: a readable
 * sanitized prefix plus a content digest, so distinct roots that
 * sanitize identically (`a/b` vs `a:b`) or differ only past the
 * prefix never share a cache file.
 */
function safeCacheKey(rootId: string): string {
  const prefix = rootId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";
  const digest = createHash("sha256").update(rootId).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

/**
 * Cache file for a lineage root under an owner scope.
 *
 * The scope is part of the KEY, not merely of the payload. The cache
 * persists a context pack to disk, so a path keyed only on the lineage
 * root would let one agent's refresh materialize its memories into the
 * exact file another scope reads back - a disk-persisted leak that
 * outlives the process that caused it.
 *
 * The key uses the ENFORCED scope, resolved here rather than by the
 * caller, so no call site can key on a scope that does not actually
 * narrow the payload. That distinction is load-bearing:
 * `coerceAgentScope(ctx, args, true)` falls back to `resolveAgentName`,
 * which ALWAYS returns a string (the literal `"agent"` when nothing is
 * configured), so `brain_anticipatory_context` passes a scope on every
 * call regardless of the gate - while the two writers that warm the
 * cache (the session-lifecycle hook and `o2b brain anticipate --refresh`)
 * pass none. Keying on the REQUESTED scope therefore made the MCP read a
 * permanent miss on a default vault, rebuilding a full `packContext` on
 * every call. Under `off` and `warn` the pack is not narrowed either, so
 * one file is the correct answer as well as the pre-gate one; only `fail`
 * splits the cache, which is exactly when the payloads genuinely differ.
 *
 * An absent or non-enforcing scope keeps the legacy filename
 * byte-for-byte, so warm caches written before the gate existed are still
 * found.
 */
export function anticipatoryCachePath(
  vault: string,
  rootSessionId: string,
  agentScope?: string | null,
): string {
  const scope = resolveOwnerScopeDelivery(vault, agentScope ?? undefined).enforcedScope;
  const key = safeCacheKey(scope === null ? rootSessionId : `${rootSessionId}\u0000${scope}`);
  return ensureInsideVault(join(vault, CACHE_DIR_REL, `${key}.json`), vault);
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
    if (typeof cache.max_tokens !== "number") return null;
    if (cache.context === null || typeof cache.context !== "object") return null;
    if (!Array.isArray(cache.context.items) || !Array.isArray(cache.context.session_hits)) {
      return null;
    }
    // An entry that carries no readable stamp is a miss, never an
    // unstamped hit: the whole point of the stamp is that a persisted
    // pack is verified rather than trusted, and a file that cannot be
    // verified has nothing to offer over rebuilding.
    if (!isCacheStamp(cache.stamp)) return null;
    return cache;
  } catch {
    return null; // corrupt cache reads as a miss by contract
  }
}

function isCacheStamp(value: unknown): value is CacheStamp {
  if (value === null || typeof value !== "object") return false;
  const stamp = value as CacheStamp;
  if (typeof stamp.generated_at !== "string" || typeof stamp.expires_at !== "string") return false;
  return stamp.tokens !== null && typeof stamp.tokens === "object" && !Array.isArray(stamp.tokens);
}

interface BuildBundleInput {
  readonly sessionId: string;
  readonly signalText: string | undefined;
  readonly maxTokens: number;
  readonly agentScope: string | undefined;
  /** Injected clock; the stamp's window is anchored to it. */
  readonly now: Date;
}

interface BuiltBundle {
  readonly context: AnticipatoryContext;
  readonly stamp: ContextPackStamp;
}

function buildBundle(vault: string, input: BuildBundleInput): BuiltBundle {
  const pack = packContext(vault, {
    maxTokens: input.maxTokens,
    ...(input.agentScope !== undefined ? { agentScope: input.agentScope } : {}),
    stamp: { now: input.now },
  });
  const signal = input.signalText?.trim() ?? "";
  const hits =
    signal.length > 0
      ? searchSessionRecall(vault, {
          query: signal,
          sessionId: input.sessionId,
          limit: DEFAULT_SESSION_HITS,
        }).hits
      : Object.freeze([] as SessionRecallHit[]);
  return {
    context: Object.freeze({ items: pack.items, session_hits: hits }),
    stamp: pack.stamp,
  };
}

/**
 * Why a cached entry must not be served, or `null` when it may be.
 * Shared by the refresh debounce and the read so the two can never
 * disagree about what "still valid" means - a warm-but-drifted entry
 * that survived the debounce would be refused on every read and never
 * rebuilt until its TTL lapsed.
 */
function cacheRefusal(vault: string, cached: CacheFile, now: Date): string | null {
  return packStampRefusal(fromCacheStamp(cached.stamp), packStampTokens(vault), now);
}

/**
 * Refresh the cache for the session's lineage root unless a fresh copy
 * already exists (TTL debounce).
 *
 * Fail-soft by design: every cache-building error is swallowed and
 * reported as `refreshed: false`. The ONE exception is the vault-identity
 * refusal, which is raised ahead of the try so it cannot be mistaken for
 * an ordinary cache miss - the only caller (the session-lifecycle hook)
 * already catches, so the hook still fails open, but it fails open
 * WITHOUT having written the cache into the wrong store.
 */
export function refreshAnticipatoryCache(
  vault: string,
  input: RefreshAnticipatoryCacheInput,
): RefreshAnticipatoryCacheResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const rootId = resolveRootId(vault, input.sessionId);
  const path = anticipatoryCachePath(vault, rootId, input.agentScope);
  const ttlMs = (input.ttlSeconds ?? DEFAULT_ANTICIPATORY_TTL_SECONDS) * 1_000;
  const maxTokens = input.maxTokens ?? DEFAULT_ANTICIPATORY_MAX_TOKENS;
  try {
    const existing = readCacheFile(path);
    // TTL debounce applies only to a cache built under the same token
    // budget; a budget change always rebuilds. The signal text is
    // deliberately NOT part of the cache identity - it changes every
    // prompt, and invalidating on it would defeat the debounce that
    // makes hook-driven refresh affordable.
    //
    // The stamp overrides the debounce (context-integrity-gates, Unit
    // B): a drifted or expired entry rebuilds even inside the TTL,
    // because the stamp - not the clock - is the primary invalidator.
    // Without this the read side would refuse the same drifted entry on
    // every turn and never get a replacement until the TTL lapsed.
    if (existing !== null && existing.max_tokens === maxTokens) {
      const age = input.now.getTime() - Date.parse(existing.generated_at);
      if (
        Number.isFinite(age) &&
        age >= 0 &&
        age < ttlMs &&
        cacheRefusal(vault, existing, input.now) === null
      ) {
        return Object.freeze({ refreshed: false, rootSessionId: rootId, path });
      }
    }
    const bundle = buildBundle(vault, {
      sessionId: input.sessionId,
      signalText: input.signalText,
      maxTokens,
      agentScope: input.agentScope,
      now: input.now,
    });
    const signal = input.signalText?.trim();
    const cache: CacheFile = {
      schema: ANTICIPATORY_SCHEMA_VERSION,
      root_session_id: rootId,
      session_id: input.sessionId,
      generated_at: input.now.toISOString(),
      max_tokens: maxTokens,
      ...(signal !== undefined && signal.length > 0 ? { signal } : {}),
      stamp: toCacheStamp(bundle.stamp),
      context: bundle.context,
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
  const path = anticipatoryCachePath(vault, rootId, input.agentScope);
  const ttlMs = (input.ttlSeconds ?? DEFAULT_ANTICIPATORY_TTL_SECONDS) * 1_000;
  const requestedTokens = input.maxTokens ?? DEFAULT_ANTICIPATORY_MAX_TOKENS;
  const cached = readCacheFile(path);
  if (cached !== null) {
    const age = input.now.getTime() - Date.parse(cached.generated_at);
    if (cached.max_tokens === requestedTokens && Number.isFinite(age) && age >= 0 && age < ttlMs) {
      // Fresh by the clock is not the same as valid. The stamp decides
      // whether the persisted bundle still describes this vault, and an
      // expired window decides when a bundle stops being servable even
      // if nothing observable drifted.
      const refusal = cacheRefusal(vault, cached, input.now);
      if (refusal === null) {
        return Object.freeze({
          cache_state: "warm" as const,
          root_session_id: rootId,
          generated_at: cached.generated_at,
          context: cached.context,
        });
      }
      return Object.freeze({
        cache_state: "miss" as const,
        root_session_id: rootId,
        cache_refusal: refusal,
        context: buildBundle(vault, {
          sessionId: input.sessionId,
          signalText: cached.signal,
          maxTokens: requestedTokens,
          agentScope: input.agentScope,
          now: input.now,
        }).context,
      });
    }
    return Object.freeze({
      cache_state: "stale" as const,
      root_session_id: rootId,
      context: buildBundle(vault, {
        sessionId: input.sessionId,
        signalText: cached.signal,
        maxTokens: requestedTokens,
        agentScope: input.agentScope,
        now: input.now,
      }).context,
    });
  }
  return Object.freeze({
    cache_state: "miss" as const,
    root_session_id: rootId,
    context: buildBundle(vault, {
      sessionId: input.sessionId,
      signalText: undefined,
      maxTokens: requestedTokens,
      agentScope: input.agentScope,
      now: input.now,
    }).context,
  });
}
