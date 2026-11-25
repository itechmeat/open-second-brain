/**
 * A string map that moves to disk once it grows (change migration-memory-
 * peak). A migration, a late-write import and a rollback each need a few
 * maps with one entry per legacy item or per store record: the journal
 * (item key and checksum to the records it became), the items a pass saw,
 * every held record's checksum. A real vault holds several hundred
 * thousand of each, and held in memory they set the peak of the process.
 *
 * A {@link SpillMap} keeps its entries in memory up to the scratch's
 * threshold, then moves them into a table of a temporary SQLite file in
 * the device-local migration folder ({@link MigrationScratch}), and keeps
 * answering from there. The file is scratch, never a source of truth: it
 * is created for one run, rebuilt from the journal file and the store on
 * the next, and deleted when the run ends. A run killed before that
 * leaves it behind; the next scratch in the folder deletes the files of
 * processes that are gone.
 *
 * Without a scratch (the default) a map stays in memory: small callers
 * and unit tests pay nothing.
 */

import { Database, type Statement } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { closeDatabase } from "../sqlite-close.ts";
import { gcHintTick } from "../store/gc-hint.ts";
import { processAlive } from "./holder-liveness.ts";

/** The folder of the scratch files, inside the migration folder. */
export const SCRATCH_DIR = "scratch";
const SCRATCH_FILE_RE = /^scratch-(\d+)-[0-9a-z]+\.sqlite$/;

/** Entries a map holds in memory before it moves to disk. */
export const SPILL_AT_ENTRIES = 20_000;

/** Writes per transaction on disk: a commit costs no fsync (`synchronous=OFF`). */
const WRITES_PER_COMMIT = 8_192;

/** What a reader of a spill map needs. */
export interface ReadonlySpillMap {
  readonly size: number;
  get(key: string): string | undefined;
  has(key: string): boolean;
  /** Every entry, in no promised order. */
  entries(): IterableIterator<[string, string]>;
}

/** The temporary SQLite file the maps of one run move to. */
export class MigrationScratch {
  private db: Database | null = null;
  private path: string | null = null;
  private tables = 0;
  private pendingWrites = 0;
  readonly spillAt: number;

  constructor(
    private readonly dir: string,
    options: { readonly spillAt?: number } = {},
  ) {
    this.spillAt = Math.max(0, options.spillAt ?? SPILL_AT_ENTRIES);
    // A killed run's file goes now, not only once this run's maps grow: a
    // resumed run that never moves a map to disk removes it too.
    sweepDeadScratch(join(dir, SCRATCH_DIR));
  }

  private failure: { readonly error: unknown } | null = null;

  /**
   * Run one use of the scratch file. A use that throws (a disk full, an
   * I/O error, a failed commit, which SQLite may answer by rolling back
   * writes made before it) leaves the file's content unknown: the error
   * is rethrown, and every later use of any map of this scratch throws it
   * again, so a run never goes on reading a map that lost entries.
   */
  guard<T>(use: () => T): T {
    if (this.failure !== null) throw this.failure.error;
    try {
      return use();
    } catch (error) {
      this.failure = { error };
      throw error;
    }
  }

  /** A new empty map of this scratch. */
  map(): SpillMap {
    return new SpillMap(this);
  }

  /** The scratch's database, created on first use. */
  database(): Database {
    if (this.db !== null) return this.db;
    const folder = join(this.dir, SCRATCH_DIR);
    const path = join(
      folder,
      `scratch-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sqlite`,
    );
    let db: Database | null = null;
    try {
      db = openScratchFile(folder, path);
      // Scratch: nothing here survives a crash on purpose. The rollback
      // journal stays in memory (bounded by one commit's writes) and
      // nothing is synced.
      db.exec("PRAGMA journal_mode = MEMORY");
      db.exec("PRAGMA synchronous = OFF");
      db.exec("PRAGMA temp_store = FILE");
      db.exec("PRAGMA cache_size = -16384");
      db.exec("BEGIN");
    } catch (error) {
      // A file this process created and could not set up is released and
      // removed here: no close() would know of it, and the sweep leaves a
      // live process's files alone.
      closeDatabase(db);
      removeScratchFile(path);
      throw error;
    }
    this.db = db;
    this.path = path;
    return db;
  }

  /** A name for a new table. */
  nextTable(): string {
    this.tables += 1;
    return `m${this.tables}`;
  }

  /** Count one write; commit once enough are waiting, so a transaction stays bounded. */
  wrote(): void {
    this.pendingWrites += 1;
    if (this.pendingWrites < WRITES_PER_COMMIT || this.db === null) return;
    this.db.exec("COMMIT");
    this.db.exec("BEGIN");
    this.pendingWrites = 0;
  }

  /** Close and delete the file; every map of the scratch is unusable after. */
  close(): void {
    const db = this.db;
    const path = this.path;
    this.db = null;
    this.path = null;
    closeDatabase(db);
    if (path !== null) removeScratchFile(path);
    removeEmptyScratchFolder(join(this.dir, SCRATCH_DIR));
  }
}

/**
 * Create the scratch file at `path` in `folder`, making the folder first.
 * Another run's close may remove the folder once it is empty
 * ({@link removeEmptyScratchFolder}) between the `mkdir` and the create:
 * then it is made again, a bounded number of times.
 */
function openScratchFile(folder: string, path: string): Database {
  for (let attempt = 0; ; attempt++) {
    mkdirSync(folder, { recursive: true });
    try {
      return new Database(path, { create: true });
    } catch (error) {
      if (attempt >= 2 || existsSync(folder)) throw error;
    }
  }
}

/**
 * Remove the scratch folder when it holds nothing: a run's own file is gone
 * by now, and `rmdir` refuses a folder another live run still has a file
 * in (or one a killed run left, which the next sweep removes), so only an
 * empty folder goes. Best effort.
 */
function removeEmptyScratchFolder(folder: string): void {
  try {
    rmdirSync(folder);
  } catch {
    // not empty, already gone, or held (Windows): left as it is
  }
}

function removeScratchFile(path: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // A file another handle still holds (Windows) is left to the next sweep.
    }
  }
}

/** Delete the scratch files of processes that are gone (a run killed before its end). */
export function sweepDeadScratch(folder: string): void {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const match = SCRATCH_FILE_RE.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    removeScratchFile(join(folder, name));
  }
}

/** A string map in memory, then on disk once it passes the scratch's threshold. */
export class SpillMap implements ReadonlySpillMap {
  private memory: Map<string, string> | null = new Map();
  private table: string | null = null;
  private count = 0;
  private getStmt: Statement | null = null;
  private insertStmt: Statement | null = null;
  private updateStmt: Statement | null = null;
  private deleteStmt: Statement | null = null;

  constructor(private readonly scratch: MigrationScratch | null = null) {}

  get size(): number {
    return this.memory !== null ? this.memory.size : this.count;
  }

  /** Whether the entries moved to disk. */
  get spilled(): boolean {
    return this.memory === null;
  }

  get(key: string): string | undefined {
    if (this.memory !== null) return this.memory.get(key);
    const row = this.scratch!.guard(() => this.getStmt!.get(key) as { v: string } | null);
    return row === null ? undefined : row.v;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: string): void {
    if (this.memory !== null) {
      this.memory.set(key, value);
      if (this.scratch !== null && this.memory.size > this.scratch.spillAt) this.spill();
      return;
    }
    // A new key is one statement; only a key already there needs a second.
    const scratch = this.scratch!;
    scratch.guard(() => {
      if (this.insertStmt!.run(key, value).changes > 0) this.count += 1;
      else this.updateStmt!.run(value, key);
      scratch.wrote();
    });
  }

  delete(key: string): void {
    if (this.memory !== null) {
      this.memory.delete(key);
      return;
    }
    const scratch = this.scratch!;
    scratch.guard(() => {
      if (this.deleteStmt!.run(key).changes === 0) return;
      this.count -= 1;
      scratch.wrote();
    });
  }

  *entries(): IterableIterator<[string, string]> {
    if (this.memory !== null) {
      yield* this.memory.entries();
      return;
    }
    // Read in pages by key: a statement left iterating while the map is
    // written would see the writes, and a page needs no open cursor.
    // The first page has no lower bound, so an empty key is read too.
    const db = this.scratch!.database();
    const first = db.query(`SELECT k, v FROM ${this.table} ORDER BY k LIMIT 4096`);
    const next = db.query(`SELECT k, v FROM ${this.table} WHERE k > ?1 ORDER BY k LIMIT 4096`);
    let rows = this.scratch!.guard(() => first.all() as Array<{ k: string; v: string }>);
    while (rows.length > 0) {
      for (const row of rows) {
        gcHintTick();
        yield [row.k, row.v];
      }
      const after = rows[rows.length - 1]!.k;
      rows = this.scratch!.guard(() => next.all(after) as Array<{ k: string; v: string }>);
    }
  }

  /**
   * Move the entries to a table of the scratch file. The map answers from
   * memory until every entry is copied: a copy that fails throws, and the
   * scratch refuses every later use (`MigrationScratch.guard`), so no map
   * is ever left answering from a partial table.
   */
  /**
   * Every entry in key order (code units; the scratch's byte order is the
   * same for the ASCII-led keys its callers sort by).
   */
  *sortedEntries(): IterableIterator<[string, string]> {
    if (this.memory === null) {
      yield* this.entries();
      return;
    }
    yield* [...this.memory.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private spill(): void {
    const scratch = this.scratch!;
    const memory = this.memory!;
    scratch.guard(() => {
      const db = scratch.database();
      const table = scratch.nextTable();
      db.exec(`CREATE TABLE ${table} (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`);
      const insert = db.query(`INSERT OR IGNORE INTO ${table} (k, v) VALUES (?1, ?2)`);
      for (const [key, value] of memory) {
        insert.run(key, value);
        scratch.wrote();
      }
      this.getStmt = db.query(`SELECT v FROM ${table} WHERE k = ?1`);
      this.insertStmt = insert;
      this.updateStmt = db.query(`UPDATE ${table} SET v = ?1 WHERE k = ?2`);
      this.deleteStmt = db.query(`DELETE FROM ${table} WHERE k = ?1`);
      this.table = table;
    });
    this.count = memory.size;
    this.memory = null;
  }
}
