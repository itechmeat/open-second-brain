/**
 * Close a `bun:sqlite` connection so its file handles are released NOW.
 *
 * `Database.close()` without an argument calls `sqlite3_close_v2`, which
 * turns a connection with unfinalized statements into a "zombie" that
 * keeps the database file (and its `-wal`/`-shm` siblings) open until the
 * statements are garbage-collected. On POSIX that is invisible. On Windows
 * an open handle blocks delete and rename, so the index swap, snapshot
 * restore, uninstall and every temp-vault cleanup fail with `EBUSY` for as
 * long as the process lives.
 *
 * `close(true)` finalizes the connection's statements and closes
 * immediately. If it throws (a statement still executing), fall back to
 * the lazy close so a caller's `finally` never turns into a new failure.
 */

import type { Database } from "bun:sqlite";

export function closeDatabase(db: Database | null | undefined): void {
  if (!db) return;
  try {
    db.close(true);
  } catch {
    db.close();
  }
}
