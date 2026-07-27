/**
 * Opening, healing and closing the index file: crash recovery from a
 * reindex `.bak`, the connection pragmas, the schema gate a read open
 * refuses on, and the WAL consolidation an orderly close owes the next
 * opener.
 *
 * Everything here is about the FILE, not about any one table.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import { applyMigrations, LATEST_SCHEMA_VERSION, readSchemaVersion } from "../schema.ts";
import { SearchError } from "../types.ts";
import type { ResolvedSearchConfig } from "../types.ts";
import { ensureFts5 } from "./keyword.ts";
import { loadVecExtension } from "./vectors.ts";
import { acquireWriterLock, acquireWriterLockSync } from "./writer-lock.ts";

/** A connection on the index, plus the vec ABI it opened under. */
export interface OpenedDatabase {
  readonly db: Database;
  /** sqlite-vec version this connection loaded, or null when unavailable. */
  readonly vecVersion: string | null;
}

/** {@link OpenedDatabase} plus the writer lock the caller now owns. */
export interface OpenedWriteDatabase extends OpenedDatabase {
  readonly release: () => Promise<void>;
}

function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  // Wait briefly for a concurrent writer (e.g. an indexer holding the WAL
  // write lock) instead of failing immediately with SQLITE_BUSY. Matters
  // for the opportunistic query-cache writes a read-mode connection makes
  // during search (v0.20.0); search itself also degrades gracefully.
  db.exec("PRAGMA busy_timeout = 5000");
}

/**
 * Crash-recovery preamble shared by every `Store.open`: if the live
 * index file is absent but a `.bak` from a `reindex` rename swap is present,
 * restore it. Guarded by the SAME writer lock `reindexVault` holds across
 * its swap, so a read that opens during the swap's brief db-absent window
 * cannot mistake it for a crashed reindex and clobber the freshly built
 * index with the stale `.bak` (the silent-data-loss race, A.2).
 *
 * Lock semantics distinguish the two cases without a heuristic:
 *   - a live reindex mid-swap holds a heartbeated (non-stale) lock, so we
 *     block briefly, then find `dbPath` present and skip the restore;
 *   - a genuine crash leaves a stale lock (no heartbeat) that is taken over
 *     within the stale window, after which we restore.
 * If the lock cannot be taken at all we skip the restore rather than risk a
 * clobber; the caller's open path then re-evaluates existence and reports
 * honestly (INDEX_MISSING). The `.bak` restore of a genuine crash is
 * unaffected: with no live holder the lock is acquired immediately.
 */
export function restoreFromBakIfMissing(dbPath: string): void {
  const bak = dbPath + ".bak";
  if (existsSync(dbPath) || !existsSync(bak)) return;
  let release: (() => void) | null = null;
  try {
    release = acquireWriterLockSync(dbPath);
  } catch {
    // A live writer holds the lock (mid-swap). Do not restore — the swap
    // will place the fresh index; the open path re-checks existence.
    return;
  }
  try {
    // Re-check under the lock: the swap may have completed while we waited,
    // or another opener may have already restored.
    if (existsSync(dbPath) || !existsSync(bak)) return;
    renameSync(bak, dbPath);
    // eslint-disable-next-line no-console
    console.error(`restored search index from ${bak} (previous reindex crash)`);
  } catch {
    /* fall through — open path below will report INDEX_MISSING */
  } finally {
    release();
  }
}

/**
 * The read open's schema gate. A corrupt or non-OSB sqlite file at the
 * index path can make readSchemaVersion throw raw SQLITE errors (e.g.
 * "no such table: index_state"). Surface those as a typed
 * INDEX_UNREADABLE so callers see a code, not a stray Error.
 */
function assertSchemaIsCurrent(db: Database, dbPath: string): void {
  let version: number;
  try {
    version = readSchemaVersion(db);
  } catch (e) {
    if (e instanceof SearchError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new SearchError("INDEX_UNREADABLE", `cannot read schema_version from ${dbPath}: ${msg}`);
  }
  if (version !== LATEST_SCHEMA_VERSION) {
    throw new SearchError(
      "SCHEMA_MISMATCH",
      `index schema version ${version} != ${LATEST_SCHEMA_VERSION}. Run: o2b search reindex`,
    );
  }
}

/**
 * Open the index for reading: no lock, no migration. An index at an
 * older schema is refused rather than upgraded, because a reader holds
 * no writer lock and must not migrate under a concurrent writer.
 */
export function openReadDatabase(config: ResolvedSearchConfig, loadVec: boolean): OpenedDatabase {
  if (!existsSync(config.dbPath)) {
    throw new SearchError(
      "INDEX_MISSING",
      `search index not initialised at ${config.dbPath}. Run: o2b search index`,
    );
  }
  let db: Database;
  try {
    db = new Database(config.dbPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SearchError("INDEX_UNREADABLE", `cannot open ${config.dbPath}: ${msg}`);
  }
  try {
    applyPragmas(db);
    ensureFts5(db);
    assertSchemaIsCurrent(db, config.dbPath);
    return { db, vecVersion: loadVec ? loadVecExtension(db) : null };
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * Open the index for writing: create the file if absent, take the
 * exclusive writer lock, then migrate to the current schema. The
 * returned `release` is the caller's to hold until close.
 */
export async function openWriteDatabase(
  config: ResolvedSearchConfig,
  loadVec: boolean,
): Promise<OpenedWriteDatabase> {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  if (!existsSync(config.dbPath)) {
    const seed = new Database(config.dbPath);
    seed.close();
  }

  const release = await acquireWriterLock(config.dbPath);

  let db: Database;
  try {
    db = new Database(config.dbPath);
  } catch (e) {
    await release();
    const msg = e instanceof Error ? e.message : String(e);
    throw new SearchError("INDEX_UNREADABLE", `cannot open ${config.dbPath}: ${msg}`);
  }

  try {
    applyPragmas(db);
    applyMigrations(db, { ftsTokenize: config.ftsTokenize });
    ensureFts5(db);
    return { db, vecVersion: loadVec ? loadVecExtension(db) : null, release };
  } catch (e) {
    await abandonWriteDatabase(db, release);
    throw e;
  }
}

/** Unwind a write open that failed after the lock was taken. */
export async function abandonWriteDatabase(
  db: Database,
  release: () => Promise<void>,
): Promise<void> {
  try {
    db.close();
  } catch {
    /* ignore close errors */
  }
  await release();
}

/**
 * Writer mode: consolidate WAL into the main file and switch back to
 * DELETE journal mode so the `-wal`/`-shm` siblings are removed. This
 * matters for `reindexVault`: after the temp-file rename swap, any
 * orphan `*-wal` next to the new main would trigger
 * SQLITE_IOERR_SHORT_READ on the next open.
 */
export function consolidateWal(db: Database): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode = DELETE");
  } catch (e) {
    // Don't fail the close, but make the failure visible — an
    // unconsolidated WAL is the exact thing that triggers
    // SQLITE_IOERR_SHORT_READ after a `reindexVault` rename swap.
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error(`search store: WAL consolidation failed on close: ${msg}`);
  }
}
