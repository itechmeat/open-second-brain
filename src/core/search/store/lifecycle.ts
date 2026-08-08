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

import {
  applyMigrations,
  findSchemaGaps,
  formatSchemaGaps,
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
  REINDEX_COMMAND,
  type SchemaGap,
} from "../schema.ts";
import { SearchError } from "../types.ts";
import type { ResolvedSearchConfig } from "../types.ts";
import { ensureFts5 } from "./keyword.ts";
import { nowIso } from "./sql.ts";
import {
  deleteState,
  getState,
  INTEGRITY_CHECKED_AT_STATE_KEY,
  INTEGRITY_FAULT_STATE_KEY,
  setState,
} from "./state.ts";
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
 *
 * The version integer alone is not the schema. A file stamped with the
 * current version whose `chunk_entities` table or `documents.authored_at`
 * column has gone missing passes the integer comparison and then fails
 * deep inside a query with a raw `no such table` / `no such column`, which
 * names no exit. The presence check closes that: it compares the file
 * against the manifest DERIVED from the migrations (see
 * {@link findSchemaGaps}) and refuses through the SAME `SCHEMA_MISMATCH`
 * that already names the reindex command, because a structurally
 * incomplete index is a schema mismatch by any useful definition.
 *
 * It is metadata-only - a table listing plus one `table_info` per expected
 * table - and costs about a third of a millisecond on the query hot path.
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
      `index schema version ${version} != ${LATEST_SCHEMA_VERSION}. Run: ${REINDEX_COMMAND}`,
    );
  }
  let gaps: ReadonlyArray<SchemaGap>;
  try {
    gaps = findSchemaGaps(db);
  } catch (e) {
    if (e instanceof SearchError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new SearchError("INDEX_UNREADABLE", `cannot read the schema of ${dbPath}: ${msg}`);
  }
  if (gaps.length > 0) {
    throw new SearchError(
      "SCHEMA_MISMATCH",
      `index at ${dbPath} is stamped schema version ${version} but is missing ` +
        `${formatSchemaGaps(gaps)}. Run: ${REINDEX_COMMAND}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The structural integrity gate
// ─────────────────────────────────────────────────────────────────────────────

/** `PRAGMA quick_check`'s verdict text when the file is intact. */
const QUICK_CHECK_OK = "ok";

/**
 * Errors `PRAGMA quick_check` is asked to report before it stops. A
 * refusal needs a cause, not an inventory, and a bounded list keeps a
 * badly damaged file from producing a megabyte of verdict text.
 */
const QUICK_CHECK_MAX_ERRORS = 5;

/**
 * How long a completed full check stands for. The scan is linear in the
 * size of the index and I/O bound, so its rate is a property of the
 * machine, not of this code: between roughly 8 and 22 ms per megabyte on
 * the hosts it has been measured on, which is seconds to tens of seconds
 * for a gigabyte-scale index. That is why it can never run on the read
 * path (that is per query) and why even the write path runs it at most
 * once a day rather than on every open.
 *
 * This interval governs how often the SCAN runs. It says nothing about
 * whether an already-recorded fault is honoured - see
 * {@link runWriteOpenIntegrityGate}.
 */
const INTEGRITY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The outcome of a completed full structural scan. */
export type IntegrityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly fault: string };

/**
 * Run `PRAGMA quick_check` and classify the result.
 *
 * Three outcomes collapse to "faulty", and deliberately so: a verdict
 * other than `ok`, a scan that raises SQLITE_CORRUPT because the damage
 * stops it completing, and a scan that returns no verdict row at all.
 * None of them is evidence of a healthy file, so none of them may pass.
 */
export function runIntegrityCheck(db: Database): IntegrityVerdict {
  let rows: ReadonlyArray<{ quick_check: string }>;
  try {
    rows = db
      .query<{ quick_check: string }, []>(`PRAGMA quick_check(${QUICK_CHECK_MAX_ERRORS})`)
      .all();
  } catch (e) {
    return { ok: false, fault: e instanceof Error ? e.message : String(e) };
  }
  if (rows.length === 0) return { ok: false, fault: "quick_check returned no verdict" };
  const verdict = rows.map((r) => r.quick_check).join("; ");
  return verdict === QUICK_CHECK_OK ? { ok: true } : { ok: false, fault: verdict };
}

/** The message every refusal on a recorded fault carries. */
function integrityFaultMessage(dbPath: string, fault: string): string {
  return (
    `search index at ${dbPath} failed a structural integrity check: ${fault}. ` +
    `Run: ${REINDEX_COMMAND}`
  );
}

/**
 * The refusal every open owes a condemned file: consult the verdict a
 * previous FULL check recorded, and refuse while it stands.
 *
 * No open can afford to run the scan unconditionally - a read open happens
 * on every single query and the scan costs seconds - so what every open
 * can honestly do is refuse to touch a file that a completed check found
 * malformed. That costs one key lookup and is therefore affordable
 * everywhere, which is why it is applied everywhere rather than only on
 * the read path. The absence of a fault is NOT a pass and is never
 * reported as one: it means either that the last check passed or that no
 * check has run here yet, and `integrity_checked_at` is the only thing
 * that distinguishes those two.
 */
function assertNoRecordedIntegrityFault(db: Database, dbPath: string): void {
  const fault = getState(db, INTEGRITY_FAULT_STATE_KEY);
  if (fault === null) return;
  throw new SearchError("INDEX_UNREADABLE", integrityFaultMessage(dbPath, fault));
}

/**
 * Whether a fresh full scan is due: true unless a completed scan is
 * recorded within {@link INTEGRITY_CHECK_INTERVAL_MS}.
 *
 * A stamp that is absent, unparseable, or in the FUTURE (a clock that
 * moved backwards) all mean the same thing: nothing here can be relied on
 * to say when the last scan happened, so scan.
 */
function fullScanIsDue(db: Database): boolean {
  const stamp = getState(db, INTEGRITY_CHECKED_AT_STATE_KEY);
  const ageMs = stamp === null ? Number.NaN : Date.now() - Date.parse(stamp);
  return !(Number.isFinite(ageMs) && ageMs >= 0 && ageMs < INTEGRITY_CHECK_INTERVAL_MS);
}

/**
 * The write open's integrity gate: run the scan when one is due, and
 * otherwise honour the verdict the last one recorded - BOTH of its arms.
 *
 * That second clause is the whole point, and it used to be missing. The
 * recorded fault is a cached verdict and the interval is its lifetime; the
 * bug was applying that lifetime to the PASSING arm only. A completed scan
 * that condemns the file stamps `integrity_checked_at` exactly as a
 * passing one does, so an interval that short-circuited before anything
 * consulted `integrity_fault` skipped the gate entirely for the next 24
 * hours on precisely the files that had just been condemned - and
 * `o2b search check --integrity` produces that state on demand, so running
 * the diagnostic on a damaged index opened the window rather than closing
 * it. Within the interval the verdict now stands as a whole: a pass means
 * skip the scan, a fault means refuse, as it always has on the read path.
 *
 * A DUE scan still re-derives the verdict rather than trusting the cached
 * one, which is what lets a fault the operator has since repaired be
 * cleared instead of becoming permanent.
 *
 * The scan itself runs here and nowhere else. This is the one seam
 * where a multi-second scan is already noise - an index run reads, chunks
 * and often embeds the whole vault - and it is also the moment it matters
 * most, because everything after it WRITES into the file. The verdict is
 * recorded in `index_state`, which needs no migration, so the read path
 * can act on it for the price of one key lookup.
 *
 * The interval is the cost control for the scan alone: a burst of index
 * runs pays for one scan, not one per open. The price of that is stated
 * plainly - corruption arising inside the window is not noticed until the
 * window closes. Paying for a scan on every write open instead would put
 * tens of seconds in front of every `o2b brain tiers` invocation, and
 * paying it on the read path would put it in front of every query.
 *
 * The refusal leaves exactly one exit, and it is not blocked by this gate:
 * `reindexVault` builds into a `.new` staging file and swaps it in, so it
 * never opens the condemned file for writing. A condemned index therefore
 * stays repairable by `o2b search reindex` - and by the `openReadOrSelfHeal`
 * rebuild the query path performs for itself - which is what makes
 * refusing every other write open safe.
 *
 * Recording is best effort - a file damaged badly enough may refuse the
 * write - but the REFUSAL is not: the fault is thrown either way, naming
 * its cause and its exit.
 */
function runWriteOpenIntegrityGate(db: Database, dbPath: string): void {
  if (!fullScanIsDue(db)) {
    // No scan this open - so the last one's verdict is what stands, and a
    // condemning verdict must refuse here just as it does on a read open.
    assertNoRecordedIntegrityFault(db, dbPath);
    return;
  }

  const verdict = runIntegrityCheck(db);
  try {
    setState(db, INTEGRITY_CHECKED_AT_STATE_KEY, nowIso());
    if (verdict.ok) deleteState(db, INTEGRITY_FAULT_STATE_KEY);
    else setState(db, INTEGRITY_FAULT_STATE_KEY, verdict.fault);
  } catch (e) {
    if (verdict.ok) throw e;
    // The file is malformed AND will not accept the record of it. The
    // refusal below still names the cause; only the memo is lost.
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error(`search store: could not record the integrity fault in ${dbPath}: ${msg}`);
  }
  if (!verdict.ok) {
    throw new SearchError("INDEX_UNREADABLE", integrityFaultMessage(dbPath, verdict.fault));
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
    assertNoRecordedIntegrityFault(db, config.dbPath);
    return { db, vecVersion: loadVec ? loadVecExtension(db) : null };
  } catch (e) {
    db.close();
    if (e instanceof SearchError) throw e;
    // `new Database()` above is lazy: a file that is not a SQLite database
    // at all only raises on the FIRST statement, which is `applyPragmas`.
    // Untyped, that error escaped the self-heal path this module's callers
    // rely on, so the very case the read path documents itself as healing -
    // a non-OSB file at the index path - was the one it did not heal.
    const msg = e instanceof Error ? e.message : String(e);
    throw new SearchError("INDEX_UNREADABLE", `cannot open ${config.dbPath}: ${msg}`);
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
    runWriteOpenIntegrityGate(db, config.dbPath);
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
