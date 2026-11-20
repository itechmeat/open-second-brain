/**
 * The migration journal (design D11 step 5): one row per imported legacy
 * item, in this machine's device-local state, never synced:
 *
 *   { key, sum, ids, sums, partition, vault }
 *
 * `key` is the item (vault-relative path, and `#<line>` for a line of an
 * append-only file), `sum` the checksum of its content, `ids` and `sums`
 * the ids and body checksums of the store records it became, `vault` the
 * vault it came from (`journal-scope.ts`). Matching uses the vault, the
 * key AND the checksum, so two legacy items with the same content stay two
 * records, an identical item at the same path of another vault is that
 * vault's own item, and an item whose content changed is imported again.
 *
 * A run reads the journal for the vault it imports: rows of that vault
 * under their item key, rows of any other vault under a key of their own
 * ({@link foreignKey}), so their records still count as claimed.
 *
 * The store is the journal's backstop: a record is appended before its
 * journal row, so a run killed between the two leaves a record whose
 * `migrated` mark (`migration-records.ts`) names the item. A resumed run
 * reads those marks back ({@link journalFromStore}) and never imports the
 * item twice.
 *
 * Beside the journal sits `state.json`, the run's phase, so a second run
 * can tell an interrupted migration from a fresh one.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import type { StorePartition } from "../store/constants.ts";
import {
  DIGEST_STREAM,
  forEachPartitionRecord,
  forEachPartitionShard,
  readPartition,
  type PartitionShard,
  type PartitionShardHead,
  type ReadPartitionOptions,
} from "../store/state-digest.ts";
import type { StoreRecord } from "../store/envelope.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { partitionDir } from "../store/store-paths.ts";
import {
  dualWriteFromVault,
  markVault,
  parseJournalVault,
  rowVault,
  sameJournalVault,
  type JournalScope,
  type JournalVault,
} from "./journal-scope.ts";
import { migratedMark, writtenWhileSwitched } from "./migration-records.ts";
import { SpillMap, type MigrationScratch, type ReadonlySpillMap } from "./spill-map.ts";

/** The device-local folder of the migration, inside the store's device state. */
export const MIGRATION_STATE_DIR = "migration";
const JOURNAL_FILE = "journal.jsonl";
/** The run state file in the migration folder. */
export const MIGRATION_STATE_FILE = "state.json";
const STATE_FILE = MIGRATION_STATE_FILE;

/**
 * One journaled item version: the records a (key, checksum) became, one
 * per part, in part order. A part not written yet is the empty string.
 */
export interface JournalRow {
  readonly key: string;
  readonly sum: string;
  readonly ids: ReadonlyArray<string>;
  readonly sums: ReadonlyArray<string>;
  readonly partition: StorePartition;
  /** The vault the item came from; absent in a row written before it was recorded. */
  readonly vault?: JournalVault | null;
}

/** Where a journal entry came from: the store's marks, or the journal file. */
const FROM_STORE = "S";
const FROM_DISK = "D";

/**
 * Every journaled version, by key and checksum. The key is the item key
 * for a row of the vault the run imports, {@link foreignKey} for a row of
 * another vault. A journal built with a {@link MigrationScratch} moves to
 * the scratch's file once it grows (`spill-map.ts`): a real vault's
 * journal holds a row per legacy item, several hundred thousand of them,
 * and held in memory it set the run's peak.
 */
export class Journal {
  private readonly entries: SpillMap;

  constructor(scratch: MigrationScratch | null = null) {
    this.entries = scratch === null ? new SpillMap() : scratch.map();
  }

  /** How many item versions it holds. */
  get size(): number {
    return this.entries.size;
  }

  get(at: string, sum: string): JournalRow | undefined {
    return this.entry(at, sum)?.row;
  }

  /** The entry at (at, sum), and whether it came from the journal file. */
  entry(at: string, sum: string): { readonly row: JournalRow; readonly disk: boolean } | undefined {
    const value = this.entries.get(entryKey(at, sum));
    if (value === undefined) return undefined;
    return { row: JSON.parse(value.slice(1)) as JournalRow, disk: value[0] === FROM_DISK };
  }

  set(at: string, row: JournalRow, from: "store" | "disk" = "store"): void {
    this.entries.set(
      entryKey(at, row.sum),
      (from === "disk" ? FROM_DISK : FROM_STORE) + JSON.stringify(row),
    );
  }

  /** Every row, in no promised order. */
  *rows(): IterableIterator<JournalRow> {
    for (const [, value] of this.entries.entries()) yield JSON.parse(value.slice(1)) as JournalRow;
  }
}

/** The map key of a journal entry: the checksum holds no separator, the key may. */
function entryKey(at: string, sum: string): string {
  return `${sum}\u0001${at}`;
}

/** The journal key of a row of a vault other than the one a run imports. */
function foreignKey(vault: JournalVault, key: string): string {
  return `\u0000${vault.vault_id ?? ""}\u0000${vault.path_sum}\u0000${key}`;
}

/** The journal key of a row from `vault`, as the run of `scope` reads it. */
function scopedKey(scope: JournalScope, vault: JournalVault, key: string): string {
  return sameJournalVault(vault, scope.vault) ? key : foreignKey(vault, key);
}

export function journalGet(journal: Journal, key: string, sum: string): JournalRow | undefined {
  return journal.get(key, sum);
}

/** Record `row` under its item key: a row of the vault the run imports. */
export function journalSet(journal: Journal, row: JournalRow): void {
  journal.set(row.key, row);
}

/** Whether every part of a row was written. */
export function rowComplete(row: JournalRow): boolean {
  return row.ids.length > 0 && row.ids.every((id) => id !== "");
}

/**
 * The ids among `ids` that a journal row names: one pass over the
 * journal, keeping only those ids.
 */
export function journalClaimedAmong(journal: Journal, ids: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (ids.size === 0) return out;
  for (const row of journal.rows()) for (const id of row.ids) if (ids.has(id)) out.add(id);
  return out;
}

export type MigrationPhase = "in-progress" | "failed" | "done" | "rolled-back";

export interface MigrationState {
  readonly run_id: string;
  readonly phase: MigrationPhase;
  readonly started_at: string;
  readonly updated_at: string;
  /** Whether the backups and the snapshot were taken and verified. */
  readonly backed_up: boolean;
  readonly reason?: string;
}

export function migrationDir(store: Pick<StoreHandle, "deviceStateDir">): string {
  return join(store.deviceStateDir, MIGRATION_STATE_DIR);
}

/**
 * This device's run state as one read of its file found it: `absent` when
 * there is no file (no run), `unreadable` when the folder or the file
 * cannot be read or the file does not parse as a run, or the run. A read
 * that fails is never `absent`: it could hide a run the operator rolled
 * back. Every module reads the run state through this function, and acts
 * on this one answer: no second look at the file decides.
 */
export type MigrationStateRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly error: string }
  | { readonly kind: "state"; readonly state: MigrationState };

export function readMigrationState(dir: string): MigrationStateRead {
  let text: string;
  try {
    text = readFileSync(join(dir, STATE_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { run_id?: unknown }).run_id !== "string" ||
    typeof (parsed as { phase?: unknown }).phase !== "string"
  ) {
    return { kind: "unreadable", error: "the run state is not a run" };
  }
  return { kind: "state", state: parsed as MigrationState };
}

/**
 * The record a rollback writes once it restored the legacy tree, and
 * removes as its last step (`rollback.ts`): while it is there, a rollback
 * of this machine began and did not finish.
 */
export const ROLLBACK_STATE_FILE = "rollback.json";

/**
 * This machine's rollback record as one read of it found it: `absent`
 * when there is none, `there` when a rollback began and did not finish
 * (whatever the file holds: a torn record is a rollback that began too),
 * `unreadable` when the folder or the file cannot be read. A read that
 * fails is never `absent`: it could hide a rollback the operator began.
 */
export type RollbackRecordRead = "absent" | "there" | "unreadable";

export function readRollbackRecord(dir: string): RollbackRecordRead {
  try {
    readFileSync(join(dir, ROLLBACK_STATE_FILE));
    return "there";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
  }
}

/** The journal of the records a rollback wrote back (`rollback.ts`). */
export const ROLLBACK_JOURNAL_FILE = "rollback-journal.jsonl";

/**
 * Remove a rollback's record and journal: a migration the operator runs
 * over a rollback that did not finish ends that rollback, and a later
 * rollback starts from the new migration's snapshot.
 */
export function clearRollbackRecord(dir: string): void {
  rmSync(join(dir, ROLLBACK_STATE_FILE), { force: true });
  rmSync(join(dir, ROLLBACK_JOURNAL_FILE), { force: true });
}

export function writeMigrationState(dir: string, state: MigrationState): void {
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Bytes of the journal file read per call. */
const JOURNAL_READ_CHUNK = 1024 * 1024;

/**
 * Every parseable row of the journal file, in file order, read in chunks:
 * a real vault's journal holds a row per legacy item, and read whole it
 * is one string of every row.
 */
function forEachJournalFileRow(dir: string, onRow: (row: JournalRow) => void): void {
  const path = join(dir, JOURNAL_FILE);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const take = (line: string): void => {
    if (line.trim() === "") return;
    let row: JournalRow;
    try {
      row = JSON.parse(line) as JournalRow;
    } catch {
      // a torn last row: its records are recovered from the store
      return;
    }
    if (row === null || typeof row !== "object") return;
    // Outside the parse: a row the consumer cannot keep (a scratch write
    // that fails) ends the read instead of passing for a torn row.
    if (typeof row.key === "string" && typeof row.sum === "string" && Array.isArray(row.ids)) {
      onRow(row);
    }
  };
  try {
    const chunk = Buffer.alloc(JOURNAL_READ_CHUNK);
    let carry: Buffer[] = [];
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let cursor = 0;
      for (;;) {
        const end = chunk.subarray(0, n).indexOf(0x0a, cursor);
        if (end === -1) {
          carry.push(Buffer.from(chunk.subarray(cursor, n)));
          break;
        }
        carry.push(chunk.subarray(cursor, end));
        take(Buffer.concat(carry).toString("utf8"));
        carry = [];
        cursor = end + 1;
      }
    }
    if (carry.length > 0) take(Buffer.concat(carry).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** The journal rows on disk, as the run of `scope` reads them. */
export function readJournal(
  dir: string,
  scope: JournalScope,
  scratch: MigrationScratch | null = null,
): Journal {
  const out = new Journal(scratch);
  forEachJournalFileRow(dir, (row) => {
    const vault = rowVault(scope, parseJournalVault(row.vault));
    out.set(scopedKey(scope, vault, row.key), row, "disk");
  });
  return out;
}

export function appendJournal(dir: string, row: JournalRow): void {
  appendJournalRows(dir, [row]);
}

/** Append several journal rows with one write, in order. */
export function appendJournalRows(dir: string, rows: ReadonlyArray<JournalRow>): void {
  if (rows.length === 0) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, JOURNAL_FILE), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/**
 * The journal as the store tells it: every record of ANY device that
 * carries a `migrated` mark, grouped by vault, item key and checksum, each
 * in its part slot. A later machine therefore skips what the first one
 * imported of the same vault, and an item with a part missing is completed
 * rather than imported again.
 */
export function journalFromStore(
  store: StoreHandle,
  scope: JournalScope,
  held?: ReadonlyMap<StorePartition, ReadonlyArray<StoreRecord>>,
  scratch: MigrationScratch | null = null,
): Journal {
  const folder = markFolder(scope, scratch);
  if (held !== undefined) {
    for (const [partition, records] of held)
      for (const record of records) folder.fold(partition, record);
  } else {
    // Record by record: only the journal (ids and checksums per item key)
    // is kept, never the store's records.
    forEachHeldRecord(store, (partition, record) => {
      folder.fold(partition, record);
    });
  }
  return folder.journal;
}

/** Folds records carrying a `migrated` mark into a journal, as {@link journalFromStore} reads them. */
function markFolder(
  scope: JournalScope,
  scratch: MigrationScratch | null,
): {
  readonly journal: Journal;
  /** Fold one record; false when it carries no mark. */
  fold(partition: StorePartition, record: StoreRecord): boolean;
} {
  const out = new Journal(scratch);
  return {
    journal: out,
    fold: (partition, record) => {
      const mark = migratedMark(record);
      if (mark === null) return false;
      const vault = markVault(scope, mark.vault, record);
      const at = scopedKey(scope, vault, mark.key);
      const found = out.get(at, mark.sum);
      const ids = found ? [...found.ids] : Array.from({ length: mark.parts }, () => "");
      const sums = found ? [...found.sums] : Array.from({ length: mark.parts }, () => "");
      if (ids[mark.part] !== undefined && ids[mark.part] !== "") return true; // first copy wins
      ids[mark.part] = record.id;
      sums[mark.part] = record.sum;
      out.set(at, { key: mark.key, sum: mark.sum, ids, sums, partition, vault });
      return true;
    },
  };
}

/**
 * {@link loadJournal} and the dual-written copies `dualWritePool` matches
 * items against, in one pass over the store, record by record: the run
 * keeps the journal and the copies, never the whole store. Only a record
 * that can be such a copy is kept: no `migrated` mark, not written while
 * its device was switched (a native store record, which most records of a
 * store in use are), and dual-written from this vault. With a scratch, the
 * journal moves to its file once it grows. The shards the pass could not
 * see in full are passed on; a throw of the fold (a scratch write that
 * failed) ends the pass.
 */
export function loadJournalAndUnmarked(
  dir: string,
  store: StoreHandle,
  scope: JournalScope,
  scratch: MigrationScratch | null = null,
): {
  readonly journal: Journal;
  readonly unmarked: StoreRecord[];
  readonly unseen: UnseenShards;
} {
  const unmarked: StoreRecord[] = [];
  const folder = markFolder(scope, scratch);
  const native = writtenWhileSwitched(store);
  const unseen = forEachHeldRecord(store, (partition, record) => {
    if (folder.fold(partition, record)) return;
    if (native(record) || !dualWriteFromVault(scope, record)) return;
    unmarked.push(record);
  });
  return { journal: withDiskRows(folder.journal, dir, scope), unmarked, unseen };
}

/**
 * The journal a run starts from: the store's marks, plus the rows on disk
 * that name records without a mark (dual-written copies the migration
 * matched instead of importing again).
 */
export function loadJournal(
  dir: string,
  store: StoreHandle,
  scope: JournalScope,
  held?: ReadonlyMap<StorePartition, ReadonlyArray<StoreRecord>>,
  scratch: MigrationScratch | null = null,
): Journal {
  return withDiskRows(journalFromStore(store, scope, held, scratch), dir, scope);
}

/**
 * `journal` with the rows on disk that complete it (see {@link loadJournal}):
 * a version the store's marks hold whole stays the store's; any other
 * takes the last row the file holds for it. The file is read row by row.
 */
function withDiskRows(journal: Journal, dir: string, scope: JournalScope): Journal {
  forEachJournalFileRow(dir, (row) => {
    const vault = rowVault(scope, parseJournalVault(row.vault));
    const at = scopedKey(scope, vault, row.key);
    const known = journal.entry(at, row.sum);
    if (known !== undefined && !known.disk && rowComplete(known.row)) return;
    journal.set(at, row, "disk");
  });
  return journal;
}

/**
 * Every record this machine holds, by partition, read once: a run that
 * needs them twice (the journal and the dual-write pool) passes the same
 * read to both.
 */
export function heldRecordsByPartition(
  store: Pick<StoreHandle, "root" | "partitions">,
): Map<StorePartition, StoreRecord[]> {
  const out = new Map<StorePartition, StoreRecord[]>();
  for (const partition of store.partitions) {
    const records: StoreRecord[] = [];
    for (const shard of readPartition(partitionDir(store.root, partition), {
      onUnreadable: () => {},
    })) {
      // Appended one by one: spreading a shard of several hundred thousand
      // records into one call overflows the call stack.
      for (const record of shard.all) records.push(record);
    }
    out.set(partition, records);
  }
  return out;
}

/** What verification looks a record's checksum up in. */
export interface RecordSums {
  get(id: string): string | undefined;
}

/**
 * What the end of a migration reads of the store, in one pass, record by
 * record: every held record's checksum by id (what verification checks
 * against) and the shards it could not all see (what the switch refuses
 * on). With a scratch, the checksums move to its file once they grow.
 */
export function readFinalStoreView(
  store: StoreHandle,
  scratch: MigrationScratch | null = null,
): {
  readonly sums: ReadonlySpillMap;
  readonly unseen: UnseenShards;
} {
  const sums = scratch === null ? new SpillMap() : scratch.map();
  const unseen = forEachHeldRecord(store, (_partition, record) => {
    sums.set(record.id, record.sum);
  });
  return { sums, unseen };
}

/** Every record this machine holds, by id: what verification checks against. */
export function storeRecordSums(
  store: StoreHandle,
  scratch: MigrationScratch | null = null,
): ReadonlySpillMap {
  return readFinalStoreView(store, scratch).sums;
}

/** Every verified record this machine holds, with the shard's device. */
export function heldRecords(store: StoreHandle): StoreRecord[] {
  return readHeldRecords(store).records;
}

/**
 * The held shards whose records this machine cannot all see, as
 * `<partition>/<rel>`. The `digests` stream is left out: it holds cut
 * summaries, never a record a data path imports over or writes back.
 */
export interface UnseenShards {
  /** Shards it cannot read at all, or read before and cannot find now. */
  readonly unreadable: ReadonlyArray<string>;
  /** Shards it read only in part (a blob not arrived, a bad line in the middle). */
  readonly partial: ReadonlyArray<string>;
}

/**
 * Every held shard, one at a time, with its partition, and the shards
 * whose records this machine could not all see. No shard is kept: a
 * caller that needs only part of each shard never holds the whole store.
 */
export function forEachHeldShard(
  store: Pick<StoreHandle, "root" | "partitions">,
  onShard: (partition: StorePartition, shard: PartitionShard) => void,
): UnseenShards {
  return walkHeld(store, (partition, root, options, onTotals) =>
    forEachPartitionShard(root, options, (shard) => {
      onShard(partition, shard);
      onTotals({ rel: shard.rel, pending: shard.pending.length });
    }),
  );
}

/**
 * Every held record, one at a time, with its partition, and the shards
 * whose records this machine could not all see: {@link forEachHeldShard}
 * without even one shard's records held. A store's busiest shard can hold
 * every record a migration imported.
 */
export function forEachHeldRecord(
  store: Pick<StoreHandle, "root" | "partitions">,
  onRecord: (
    partition: StorePartition,
    record: StoreRecord,
    pending: boolean,
    shard: PartitionShardHead,
  ) => void,
): UnseenShards {
  return walkHeld(store, (partition, root, options, onTotals) =>
    forEachPartitionRecord(root, options, {
      record: (shard, record, pending) => onRecord(partition, record, pending, shard),
      shard: (totals) => onTotals({ rel: totals.rel, pending: totals.pending }),
    }),
  );
}

/** The partition walk both held reads share, and the unseen shards it names. */
function walkHeld(
  store: Pick<StoreHandle, "root" | "partitions">,
  read: (
    partition: StorePartition,
    root: string,
    options: ReadPartitionOptions,
    onTotals: (shard: { readonly rel: string; readonly pending: number }) => void,
  ) => void,
): UnseenShards {
  const unreadable: string[] = [];
  const partial: string[] = [];
  for (const partition of store.partitions) {
    read(
      partition,
      partitionDir(store.root, partition),
      {
        onUnreadable: ({ rel, incomplete }) => {
          if (rel.split("/")[0] === DIGEST_STREAM) return;
          (incomplete === true ? partial : unreadable).push(`${partition}/${rel}`);
        },
      },
      (shard) => {
        // A pending blob is a gap here even when this machine quarantined its
        // line: rollback, the late import, the preflight and the legacy
        // removal refuse on it, and none of them waits for it.
        const rel = `${partition}/${shard.rel}`;
        if (
          shard.pending > 0 &&
          shard.rel.split("/")[0] !== DIGEST_STREAM &&
          !partial.includes(rel)
        ) {
          partial.push(rel);
        }
      },
    );
  }
  return { unreadable: unreadable.toSorted(), partial: partial.toSorted() };
}

/** Every held record, and the shards whose records it could not all see. */
export function readHeldRecords(store: Pick<StoreHandle, "root" | "partitions">): {
  readonly records: StoreRecord[];
  readonly unseen: UnseenShards;
} {
  const records: StoreRecord[] = [];
  const unseen = forEachHeldRecord(store, (_partition, record) => {
    records.push(record);
  });
  return { records, unseen };
}

export function unseenHeldShards(store: Pick<StoreHandle, "root" | "partitions">): UnseenShards {
  return forEachHeldRecord(store, () => {});
}

/** Whether any shard is unseen, and how a refusal names them (the first five). */
export function describeUnseen(unseen: UnseenShards): string | null {
  const all = [...unseen.unreadable, ...unseen.partial];
  if (all.length === 0) return null;
  const more = all.length > 5 ? `, and ${all.length - 5} more` : "";
  return `${all.length} store shard(s) cannot be read in full (${all.slice(0, 5).join(", ")}${more})`;
}
