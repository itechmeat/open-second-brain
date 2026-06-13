/**
 * Writer WAL-flush-on-exit registry (Indexer Durability suite,
 * t_672c751e).
 *
 * The search store runs in WAL mode. An orderly `Store.close()`
 * consolidates the WAL (`wal_checkpoint(TRUNCATE)` then
 * `journal_mode=DELETE`) and releases the lock. When `close()` is
 * bypassed - an error path that calls `process.exit`, or a signal
 * handler that lets the process exit normally - an orphan `-wal` is
 * left next to the main DB. SQLite replays it on the next open, so no
 * data is lost; this registry is a belt-and-suspenders that
 * synchronously consolidates the WAL for every still-open writer on the
 * process `exit` event, mirroring `sync-lockfile.ts`'s cleanup hook.
 *
 * It is best-effort and synchronous (bun:sqlite is synchronous and the
 * `exit` event cannot await async work): every operation is wrapped so
 * the hook can never throw. A hard kill (SIGKILL) fires no `exit`
 * event; that case relies on SQLite's own WAL replay on the next open.
 */

import type { Database } from "bun:sqlite";

const openWriters = new Set<Database>();
let exitHookInstalled = false;

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", flushRegisteredWriters);
}

/** Register an open writer DB so its WAL is consolidated on exit. */
export function registerWriterDb(db: Database): void {
  ensureExitHook();
  openWriters.add(db);
}

/** Unregister a writer DB (called from an orderly `Store.close()`). */
export function unregisterWriterDb(db: Database): void {
  openWriters.delete(db);
}

/**
 * Best-effort synchronous WAL consolidation for every registered
 * writer. Never throws: a closed, locked, or mid-write handle is
 * skipped silently. Safe to call more than once.
 */
export function flushRegisteredWriters(): void {
  for (const db of openWriters) {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // already closed / locked / mid-write — consolidation is a
      // best-effort safety net, not a correctness requirement.
    }
  }
}

/** Test-only: clear the registry without flushing. */
export function _resetWriterRegistryForTests(): void {
  openWriters.clear();
}
