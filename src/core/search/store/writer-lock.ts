/**
 * The exclusive writer lock on the index path. Every writer - a write
 * open, the reindex rebuild+swap, the crash-recovery restore, an
 * out-of-band FTS rebuild - serialises here, on the LIVE `dbPath`, so
 * there is exactly one lock and one stale window in the system.
 */

import lockfile from "proper-lockfile";

import { SearchError } from "../types.ts";

/**
 * Stale window for the writer lock (ms). A lock whose mtime is older
 * than this is treated as abandoned (crashed holder) and taken over by
 * the next writer, so a SIGKILL never wedges the index for longer than
 * this window.
 */
export const WRITER_LOCK_STALE_MS = 60_000;

/**
 * Heartbeat interval (ms): the async writer lock refreshes its mtime
 * this often so a legitimate long-running index is never mistaken for
 * a stale lock. Must stay below {@link WRITER_LOCK_STALE_MS}. NOTE: the
 * per-file document walk is synchronous, so this timer only fires
 * across the await points (embed batches); a multi-minute fully
 * synchronous walk still relies on the stale window, which 60s amply
 * covers for real vaults.
 */
export const WRITER_LOCK_HEARTBEAT_MS = 30_000;

/** The one message both lock paths report contention with. */
function contentionError(cause: unknown): SearchError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new SearchError("INDEX_LOCKED", `another writer holds the search index lock: ${msg}`);
}

export function acquireWriterLockSync(path: string): () => void {
  const maxAttempts = 10;
  const sleepMs = 50;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return lockfile.lockSync(path, { stale: WRITER_LOCK_STALE_MS, realpath: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ELOCKED") throw err;
      lastError = err;
      if (attempt < maxAttempts - 1) Bun.sleepSync(sleepMs);
    }
  }
  throw contentionError(lastError);
}

/**
 * Acquire the exclusive writer lock on the LIVE index path. Shared by
 * `Store.open({ mode: "write" })` and `reindexVault`'s rebuild+swap so both
 * serialise on the SAME lock (keyed on `dbPath`, not on the `.new` staging
 * path). Fast-fails to `INDEX_LOCKED` after a few retries rather than
 * blocking indefinitely, matching the module's fail-fast contention
 * contract. `realpath: false` lets the lock be taken before `dbPath` exists
 * (a fresh reindex has no live index yet); only the parent directory must
 * already exist.
 */
export async function acquireWriterLock(dbPath: string): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(dbPath, {
      retries: { retries: 3, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
      stale: WRITER_LOCK_STALE_MS,
      // Explicit heartbeat: refresh the lock mtime mid-run so a long index
      // is never mistaken for a stale lock and taken over.
      update: WRITER_LOCK_HEARTBEAT_MS,
      realpath: false,
    });
  } catch (e) {
    throw contentionError(e);
  }
}
