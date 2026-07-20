/**
 * Per-session hook state: a tiny, namespaced, expiry-stamped key/value store
 * shared by the delivery-track hooks (nav-tier cadence, D1; strict read-block
 * orientation, D2).
 *
 * Binding convention (design plan, D1/D2): stamps live under namespaced keys
 * (`osb.nav_tier.*`, `osb.oriented.*`); each stamp carries an explicit
 * epoch-ms expiry written by its producer; readers treat a missing, malformed,
 * or expired stamp identically (absent) and NEVER throw. This is not a new
 * general store - it is one JSON file per session scope beside the existing
 * `.open-second-brain/` hook surfaces, mirroring how the search layer scopes
 * `search-focus/<scope>.json`.
 *
 * The store is deliberately fail-soft on both sides: a read degrades to
 * "absent" on any error so a hook can never be stranded by a corrupt file, and
 * a write returns `false` rather than throwing so a hook's fail-open contract
 * holds even on a read-only or full filesystem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { acquireLockSync, type LockHandle } from "../../src/core/brain/sync-lockfile.ts";
import { resolveSessionScope } from "../../src/core/brain/session-scope.ts";

/** Directory (under the vault's `.open-second-brain/`) holding per-scope state. */
const HOOK_STATE_DIR = "hook-state";

/** Scope slug used when no session id is available (single flat lane). */
const DEFAULT_SCOPE = "default";

/** One expiry-stamped marker. `expiresAt` is epoch milliseconds. */
export interface HookStamp {
  readonly expiresAt: number;
  readonly data?: Record<string, unknown>;
}

/**
 * Normalise a raw session id into a filesystem-safe scope slug, falling back
 * to {@link DEFAULT_SCOPE} for a missing, empty, or separator-only id so a
 * host that omits the session id still gets a single stable lane rather than a
 * throw.
 */
function scopeSlug(sessionId: string | null | undefined): string {
  if (sessionId === null || sessionId === undefined || sessionId.length === 0) {
    return DEFAULT_SCOPE;
  }
  try {
    return resolveSessionScope(sessionId);
  } catch {
    return DEFAULT_SCOPE;
  }
}

/** Absolute path of the state file for one vault + session scope. */
export function hookStateFilePath(vault: string, sessionId: string | null | undefined): string {
  return join(vault, ".open-second-brain", HOOK_STATE_DIR, `${scopeSlug(sessionId)}.json`);
}

/**
 * Read the whole state object for a scope. Any failure (missing file, unreadable,
 * malformed JSON, non-object root) degrades to an empty object so callers never
 * throw and a corrupt file behaves exactly like a fresh one.
 */
function readState(vault: string, sessionId: string | null | undefined): Record<string, unknown> {
  const path = hookStateFilePath(vault, sessionId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Read one namespaced stamp. Returns `null` when the stamp is missing,
 * malformed (no numeric `expiresAt`), or expired (`expiresAt <= nowMs` -
 * expiry is exclusive). Never throws.
 */
export function readHookStamp(
  vault: string,
  sessionId: string | null | undefined,
  key: string,
  nowMs: number = Date.now(),
): HookStamp | null {
  const raw = readState(vault, sessionId)[key];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const expiresAt = record["expiresAt"];
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= nowMs) return null;
  const data = record["data"];
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return Object.freeze({ expiresAt, data: data as Record<string, unknown> });
  }
  return Object.freeze({ expiresAt });
}

/** Bounded busy-retry acquiring the per-scope advisory lock. */
const LOCK_RETRIES = 20;
/** Sleep between lock attempts (ms). 20 * 5ms ~= 100ms worst-case wait. */
const LOCK_RETRY_DELAY_MS = 5;

/** Sleep synchronously without spinning the CPU (hooks are sync end-to-end). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the scope's advisory lock, retrying on contention. The read-merge-
 * write in {@link writeHookStamp} is not atomic on its own, so two concurrent
 * hook processes could otherwise each read the file, merge their own key, and
 * clobber the other's stamp. The lock serialises that critical section; if it
 * stays contended past the retry budget we surface `null` and the caller
 * degrades to a `false` write (its fail-open contract) rather than throwing.
 */
function acquireScopeLock(path: string): LockHandle | null {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      return acquireLockSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ELOCKED") throw err;
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }
  return null;
}

/**
 * Write one namespaced stamp, preserving every other key already in the
 * scope's state file. The whole read-merge-write runs under a per-scope
 * advisory lock so concurrent hook processes cannot drop each other's stamps.
 * Returns `true` on success and `false` on any failure (unwritable filesystem,
 * unresolvable lock contention, etc.) so a producer can record the outcome
 * without ever throwing - the hooks that call this must stay fail-open.
 */
export function writeHookStamp(
  vault: string,
  sessionId: string | null | undefined,
  key: string,
  stamp: HookStamp,
): boolean {
  let lock: LockHandle | null = null;
  try {
    const path = hookStateFilePath(vault, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    lock = acquireScopeLock(path);
    if (lock === null) return false;
    const state = readState(vault, sessionId);
    state[key] =
      stamp.data !== undefined
        ? { expiresAt: stamp.expiresAt, data: stamp.data }
        : {
            expiresAt: stamp.expiresAt,
          };
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
    return true;
  } catch {
    return false;
  } finally {
    lock?.release();
  }
}
