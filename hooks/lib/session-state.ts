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

import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { acquireLockSync, type LockHandle } from "../../src/core/brain/sync-lockfile.ts";
import {
  resolveSessionScope,
  SESSION_SCOPE_MAX_LENGTH,
} from "../../src/core/brain/session-scope.ts";
import {
  derivedDirIsSymlinked,
  readRegularFileNoFollow,
} from "../../src/core/derived-store-guard.ts";
import { atomicWriteText } from "../../src/core/fs-atomic.ts";

/** The vault's hook-surface directory. */
const OSB_DIR = ".open-second-brain";

/** Directory (under {@link OSB_DIR}) holding per-scope state. */
const HOOK_STATE_DIR = "hook-state";

/** A scope state file name: a scope slug plus `.json`, nothing else. */
const SCOPE_FILE_RE = new RegExp(`^[a-z0-9-]{1,${SESSION_SCOPE_MAX_LENGTH}}\\.json$`);

/**
 * Residue a killed hook can leave beside a scope file: an atomic-write temp
 * file (`.<slug>.json.<pid>.<ms>.<rand>.tmp`), an abandoned scope lockfile
 * (`<slug>.json.lock`) and a stale-lock aside (`<slug>.json.lock.stale-<pid>`).
 */
const SCOPE_RESIDUE_RE = new RegExp(
  `^(?:\\.[a-z0-9-]{1,${SESSION_SCOPE_MAX_LENGTH}}\\.json\\.\\d+\\.\\d+\\.[0-9a-f]+\\.tmp` +
    `|[a-z0-9-]{1,${SESSION_SCOPE_MAX_LENGTH}}\\.json\\.lock(?:\\.stale-\\d+)?)$`,
);

/** Scope slug used when no session id is available (single flat lane). */
const DEFAULT_SCOPE = "default";

/** One expiry-stamped marker. `expiresAt` is epoch milliseconds. */
export interface HookStamp {
  readonly expiresAt: number;
  readonly data?: Record<string, unknown>;
}

/** Slug characters kept in front of the hash suffix of a lossy slug (47 + 1 + 16 = 64). */
const LOSSY_SLUG_KEEP = SESSION_SCOPE_MAX_LENGTH - 17;

/**
 * Normalise a raw session id into a filesystem-safe scope slug, falling back
 * to {@link DEFAULT_SCOPE} for a missing, empty, or separator-only id so a
 * host that omits the session id still gets a single stable lane rather than a
 * throw.
 *
 * When the normalisation is lossy (case, punctuation, or past 64 characters),
 * the slug is cut to {@link LOSSY_SLUG_KEEP} characters and suffixed with 16
 * hex characters of the id's SHA-256, so `Sess_ABC` and `sess-abc`, or two
 * long ids with a common prefix, never share a ledger and a queue. Ids that
 * are already slugs, such as the Claude Code and Codex UUIDs, keep their
 * plain name. The result stays inside {@link SCOPE_FILE_RE}.
 */
function scopeSlug(sessionId: string | null | undefined): string {
  if (sessionId === null || sessionId === undefined || sessionId.length === 0) {
    return DEFAULT_SCOPE;
  }
  let slug: string;
  try {
    slug = resolveSessionScope(sessionId);
  } catch {
    return DEFAULT_SCOPE;
  }
  if (slug === sessionId) return slug;
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `${slug.slice(0, LOSSY_SLUG_KEEP)}-${digest}`;
}

/** Absolute path of the state file for one vault + session scope. */
export function hookStateFilePath(vault: string, sessionId: string | null | undefined): string {
  return join(vault, OSB_DIR, HOOK_STATE_DIR, `${scopeSlug(sessionId)}.json`);
}

/**
 * True when `<vault>/.open-second-brain` or its `hook-state` directory is a
 * symbolic link. A vault received from elsewhere could point either at any
 * directory, so every reader, writer and the prune refuse such a tree: reads
 * answer empty, writes fail, the sweep removes nothing.
 */
function hookStateDirIsSymlinked(vault: string): boolean {
  return derivedDirIsSymlinked(vault, OSB_DIR, HOOK_STATE_DIR);
}

/**
 * Read the whole state object for a scope. Any failure (missing file, unreadable,
 * malformed JSON, non-object root, symlinked directory) degrades to an empty
 * object so callers never throw and a corrupt file behaves exactly like a fresh
 * one.
 */
function readState(vault: string, sessionId: string | null | undefined): Record<string, unknown> {
  return loadState(vault, sessionId) ?? {};
}

/**
 * The parsed state of a scope: `{}` when absent or when the hook-state tree is
 * symlinked, `null` when present but unusable (including a state file that is
 * not a regular file).
 */
function loadState(
  vault: string,
  sessionId: string | null | undefined,
): Record<string, unknown> | null {
  if (hookStateDirIsSymlinked(vault)) return {};
  const read = readRegularFileNoFollow(hookStateFilePath(vault, sessionId));
  if (read.status === "absent") return {};
  if (read.status !== "ok") return null;
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when the scope's state file exists but cannot be read or parsed into an
 * object - the case every reader silently treats as a fresh session, surfaced
 * so a caller can name it. Never throws.
 */
export function isHookStateCorrupt(vault: string, sessionId: string | null | undefined): boolean {
  return loadState(vault, sessionId) === null;
}

/**
 * Validate one raw stamp value. Returns `null` when it is missing, malformed
 * (no finite numeric `expiresAt`), or expired (`expiresAt <= nowMs` - expiry is
 * exclusive). A non-object `data` is dropped. Never throws.
 */
export function parseHookStamp(raw: unknown, nowMs: number): HookStamp | null {
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

/**
 * Read one namespaced stamp through {@link parseHookStamp}: `null` when the
 * stamp is missing, malformed, or expired. Never throws.
 */
export function readHookStamp(
  vault: string,
  sessionId: string | null | undefined,
  key: string,
  nowMs: number = Date.now(),
): HookStamp | null {
  return parseHookStamp(readState(vault, sessionId)[key], nowMs);
}

/** Bounded busy-retry acquiring the per-scope advisory lock. */
const LOCK_RETRIES = 20;
/** Sleep between lock attempts (ms). 20 * 5ms ~= 100ms worst-case wait. */
const HOOK_STATE_LOCK_RETRY_DELAY_MS = 5;

/**
 * Age past which a scope lockfile is presumed abandoned and taken over: three
 * times the 10 s host hook timeout, so no live hook can still hold it.
 */
export const HOOK_STATE_STALE_LOCK_MS = 30_000;

/** Sleep synchronously without spinning the CPU (hooks are sync end-to-end). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One lock attempt; `null` on contention, rethrows anything else. */
function tryLock(path: string): LockHandle | null {
  try {
    return acquireLockSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ELOCKED") throw err;
    return null;
  }
}

/** Whether the file at `path` was last modified more than the stale threshold ago. */
function isStale(path: string): boolean {
  return Date.now() - statSync(path).mtimeMs > HOOK_STATE_STALE_LOCK_MS;
}

/**
 * Take over the scope lockfile when its mtime is older than
 * {@link HOOK_STATE_STALE_LOCK_MS}, the residue of a hook killed mid-update.
 * Returns `true` when it removed one.
 *
 * The takeover is a rename to a per-process aside name, not an unlink in
 * place: a rename moves exactly one file, so of two contenders that both saw
 * the stale lock, only one moves it. The other's rename then either fails
 * (nothing there) or moves the winner's fresh lock, which the re-check of the
 * moved file catches; that lock is linked back under its name (`link` never
 * overwrites) and the takeover reports `false`. Every I/O error reports
 * `false`.
 *
 * One residual race remains: while a moved live lock is aside, between the
 * rename and the link back, the lock name is absent, so a third contender
 * arriving in that window acquires alongside the live holder; the link back
 * then fails and the live holder's lock is lost. That needs a crash residue,
 * three contenders on one scope and an arrival within microseconds, and the
 * worst outcome is a lost update to the operator's own session state.
 */
function clearStaleLock(path: string, stale: (path: string) => boolean = isStale): boolean {
  const lockPath = path + ".lock";
  const aside = `${lockPath}.stale-${process.pid}`;
  try {
    if (!stale(lockPath)) return false;
    renameSync(lockPath, aside);
  } catch {
    return false;
  }
  try {
    if (stale(aside)) return true;
    // Moved a live holder's lock: put it back before anyone can see the gap widen.
    linkSync(aside, lockPath);
    return false;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(aside);
    } catch {
      // already gone
    }
  }
}

/**
 * Test-only entry to {@link clearStaleLock} with an injected stale check, so
 * a test can reach the "moved a live lock" branch, which otherwise needs an
 * mtime change between the two checks.
 *
 * The leading underscore is this repo's marker for a test-only export.
 */
// oxlint-disable-next-line no-underscore-dangle
export const _clearStaleLockForTests = clearStaleLock;

/**
 * Acquire the scope's advisory lock. The read-merge-write is not atomic on its
 * own, so two concurrent hook processes could otherwise each read the file,
 * merge their own key, and clobber the other's stamp. A stale lockfile is
 * taken over once (rename aside, then one fresh attempt). With `tryOnce` a contended
 * lock yields `null` immediately; otherwise it retries within a bounded budget
 * before yielding `null`, and the caller degrades rather than throwing.
 */
function acquireScopeLock(path: string, tryOnce: boolean): LockHandle | null {
  const first = tryLock(path);
  if (first !== null) return first;
  if (clearStaleLock(path)) {
    const taken = tryLock(path);
    if (taken !== null) return taken;
  }
  if (tryOnce) return null;
  for (let attempt = 1; attempt < LOCK_RETRIES; attempt++) {
    sleepSync(HOOK_STATE_LOCK_RETRY_DELAY_MS);
    const handle = tryLock(path);
    if (handle !== null) return handle;
  }
  return null;
}

/**
 * Mutator applied by {@link updateHookState}: receives the scope's current
 * state (a fresh copy) and the clock, returns the state to persist plus a
 * caller-defined result.
 */
export type HookStateMutator<T> = (
  state: Record<string, unknown>,
  nowMs: number,
) => { readonly state: Record<string, unknown>; readonly result: T };

/** Outcome of {@link updateHookState}. */
export type HookStateUpdateOutcome<T> =
  | { readonly status: "ok"; readonly result: T }
  | { readonly status: "busy" }
  | { readonly status: "failed" };

/**
 * Locked read-modify-write over one scope's state file. The mutator runs while
 * the per-scope advisory lock is held, and its state is written through an
 * atomic rename so lock-free readers never see a torn file. `busy` means the
 * lock stayed contended (`tryOnce`: a single attempt, no retry); `failed`
 * means any other error, including a throwing mutator or a symlinked
 * hook-state tree (see {@link hookStateDirIsSymlinked}), in which case nothing
 * is written. Never throws.
 */
export function updateHookState<T>(
  vault: string,
  sessionId: string | null | undefined,
  mutate: HookStateMutator<T>,
  opts: { readonly tryOnce?: boolean; readonly nowMs?: number } = {},
): HookStateUpdateOutcome<T> {
  let lock: LockHandle | null = null;
  try {
    if (hookStateDirIsSymlinked(vault)) return { status: "failed" };
    const path = hookStateFilePath(vault, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    lock = acquireScopeLock(path, opts.tryOnce === true);
    if (lock === null) return { status: "busy" };
    const next = mutate(readState(vault, sessionId), opts.nowMs ?? Date.now());
    // Private mode: the re-grounding queue holds digest parts (standing and
    // scoped rules, the memory digest), the same class of text the inject
    // cache keeps at 0o600.
    atomicWriteText(path, JSON.stringify(next.state, null, 2) + "\n", { mode: 0o600 });
    return { status: "ok", result: next.result };
  } catch {
    return { status: "failed" };
  } finally {
    lock?.release();
  }
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
  const outcome = updateHookState(vault, sessionId, (state) => {
    state[key] =
      stamp.data !== undefined
        ? { expiresAt: stamp.expiresAt, data: stamp.data }
        : { expiresAt: stamp.expiresAt };
    return { state, result: true };
  });
  return outcome.status === "ok";
}

/** Default age past which {@link pruneHookStateFiles} removes a scope file. */
const PRUNE_MAX_AGE_MS = 7 * 86_400_000;
/** Default ceiling on files removed by one {@link pruneHookStateFiles} sweep. */
const PRUNE_MAX_FILES = 200;

/**
 * Delete scope state files (`<slug>.json`) and their write and lock residue
 * (see {@link SCOPE_RESIDUE_RE}) whose mtime is older than `maxAgeMs`,
 * removing at most `maxFiles` per sweep. A lock that old is far past
 * {@link HOOK_STATE_STALE_LOCK_MS}, so no live hook holds it. Symlinks and
 * any name outside those shapes are left alone, and nothing is swept
 * when `.open-second-brain` or `hook-state` is itself a symlink: a vault
 * received from elsewhere could otherwise point the sweep at any directory.
 * Returns the number of files removed; a missing directory or any I/O error
 * counts as nothing removed. Never throws.
 */
export function pruneHookStateFiles(
  vault: string,
  opts: { readonly maxAgeMs?: number; readonly maxFiles?: number; readonly nowMs?: number } = {},
): number {
  const maxAgeMs = opts.maxAgeMs ?? PRUNE_MAX_AGE_MS;
  const maxFiles = opts.maxFiles ?? PRUNE_MAX_FILES;
  const nowMs = opts.nowMs ?? Date.now();
  if (hookStateDirIsSymlinked(vault)) return 0;
  const dir = join(vault, OSB_DIR, HOOK_STATE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (removed >= maxFiles) break;
    if (!SCOPE_FILE_RE.test(name) && !SCOPE_RESIDUE_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || nowMs - st.mtimeMs <= maxAgeMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // vanished or unremovable; leave it for the next sweep
    }
  }
  return removed;
}
