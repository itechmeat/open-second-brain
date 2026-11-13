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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import type { StorePartition } from "../store/constants.ts";
import { DIGEST_STREAM, readPartition } from "../store/state-digest.ts";
import type { StoreRecord } from "../store/envelope.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { partitionDir } from "../store/store-paths.ts";
import {
  markVault,
  parseJournalVault,
  rowVault,
  sameJournalVault,
  type JournalScope,
  type JournalVault,
} from "./journal-scope.ts";
import { migratedMark } from "./migration-records.ts";

/** The device-local folder of the migration, inside the store's device state. */
export const MIGRATION_STATE_DIR = "migration";
const JOURNAL_FILE = "journal.jsonl";
const STATE_FILE = "state.json";

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

/**
 * Every journaled version, by key, then by checksum. The key is the item
 * key for a row of the vault the run imports, {@link foreignKey} for a row
 * of another vault.
 */
export type Journal = Map<string, Map<string, JournalRow>>;

/** The journal key of a row of a vault other than the one a run imports. */
function foreignKey(vault: JournalVault, key: string): string {
  return `\u0000${vault.vault_id ?? ""}\u0000${vault.path_sum}\u0000${key}`;
}

/** The journal key of a row from `vault`, as the run of `scope` reads it. */
function scopedKey(scope: JournalScope, vault: JournalVault, key: string): string {
  return sameJournalVault(vault, scope.vault) ? key : foreignKey(vault, key);
}

export function journalGet(journal: Journal, key: string, sum: string): JournalRow | undefined {
  return journal.get(key)?.get(sum);
}

/** Record `row` under its item key: a row of the vault the run imports. */
export function journalSet(journal: Journal, row: JournalRow): void {
  journalSetAt(journal, row.key, row);
}

function journalSetAt(journal: Journal, at: string, row: JournalRow): void {
  const versions = journal.get(at) ?? new Map<string, JournalRow>();
  versions.set(row.sum, row);
  journal.set(at, versions);
}

/** Whether every part of a row was written. */
export function rowComplete(row: JournalRow): boolean {
  return row.ids.length > 0 && row.ids.every((id) => id !== "");
}

/** Every id a journal names. */
export function journalIds(journal: Journal): Set<string> {
  const out = new Set<string>();
  for (const versions of journal.values()) {
    for (const row of versions.values()) for (const id of row.ids) if (id !== "") out.add(id);
  }
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

export function readMigrationState(dir: string): MigrationState | null {
  try {
    return JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as MigrationState;
  } catch {
    return null;
  }
}

export function writeMigrationState(dir: string, state: MigrationState): void {
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** The journal rows on disk, as the run of `scope` reads them. */
export function readJournal(dir: string, scope: JournalScope): Journal {
  const out: Journal = new Map();
  const path = join(dir, JOURNAL_FILE);
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as JournalRow;
      if (typeof row.key === "string" && typeof row.sum === "string" && Array.isArray(row.ids)) {
        const vault = rowVault(scope, parseJournalVault(row.vault));
        journalSetAt(out, scopedKey(scope, vault, row.key), row);
      }
    } catch {
      // a torn last row: its records are recovered from the store
    }
  }
  return out;
}

export function appendJournal(dir: string, row: JournalRow): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, JOURNAL_FILE), `${JSON.stringify(row)}\n`);
}

/**
 * The journal as the store tells it: every record of ANY device that
 * carries a `migrated` mark, grouped by vault, item key and checksum, each
 * in its part slot. A later machine therefore skips what the first one
 * imported of the same vault, and an item with a part missing is completed
 * rather than imported again.
 */
export function journalFromStore(store: StoreHandle, scope: JournalScope): Journal {
  const out: Journal = new Map();
  for (const partition of store.partitions) {
    const shards = readPartition(partitionDir(store.root, partition), { onUnreadable: () => {} });
    for (const shard of shards) {
      for (const record of shard.all) {
        const mark = migratedMark(record);
        if (mark === null) continue;
        const vault = markVault(scope, mark.vault, record);
        const at = scopedKey(scope, vault, mark.key);
        const found = out.get(at)?.get(mark.sum);
        const ids = found ? [...found.ids] : Array.from({ length: mark.parts }, () => "");
        const sums = found ? [...found.sums] : Array.from({ length: mark.parts }, () => "");
        if (ids[mark.part] !== undefined && ids[mark.part] !== "") continue; // first copy wins
        ids[mark.part] = record.id;
        sums[mark.part] = record.sum;
        journalSetAt(out, at, { key: mark.key, sum: mark.sum, ids, sums, partition, vault });
      }
    }
  }
  return out;
}

/**
 * The journal a run starts from: the store's marks, plus the rows on disk
 * that name records without a mark (dual-written copies the migration
 * matched instead of importing again).
 */
export function loadJournal(dir: string, store: StoreHandle, scope: JournalScope): Journal {
  const journal = journalFromStore(store, scope);
  for (const [at, versions] of readJournal(dir, scope)) {
    for (const row of versions.values()) {
      const known = journal.get(at)?.get(row.sum);
      if (known === undefined || !rowComplete(known)) journalSetAt(journal, at, row);
    }
  }
  return journal;
}

/** Every record this machine holds, by id: what verification checks against. */
export function storeRecordSums(store: StoreHandle): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of heldRecords(store)) out.set(record.id, record.sum);
  return out;
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

/** Every held record, and the shards whose records it could not all see. */
export function readHeldRecords(store: Pick<StoreHandle, "root" | "partitions">): {
  readonly records: StoreRecord[];
  readonly unseen: UnseenShards;
} {
  const records: StoreRecord[] = [];
  const unreadable: string[] = [];
  const partial: string[] = [];
  for (const partition of store.partitions) {
    for (const shard of readPartition(partitionDir(store.root, partition), {
      onUnreadable: ({ rel, incomplete }) => {
        if (rel.split("/")[0] === DIGEST_STREAM) return;
        (incomplete === true ? partial : unreadable).push(`${partition}/${rel}`);
      },
    })) {
      records.push(...shard.all);
      // A pending blob is a gap here even when this machine quarantined its
      // line: rollback, the late import, the preflight and the legacy
      // removal refuse on it, and none of them waits for it.
      const rel = `${partition}/${shard.rel}`;
      if (
        shard.pending.length > 0 &&
        shard.rel.split("/")[0] !== DIGEST_STREAM &&
        !partial.includes(rel)
      ) {
        partial.push(rel);
      }
    }
  }
  return {
    records,
    unseen: { unreadable: unreadable.toSorted(), partial: partial.toSorted() },
  };
}

/** {@link readHeldRecords}'s unseen shards alone. */
export function unseenHeldShards(store: Pick<StoreHandle, "root" | "partitions">): UnseenShards {
  return readHeldRecords(store).unseen;
}

/** Whether any shard is unseen, and how a refusal names them (the first five). */
export function describeUnseen(unseen: UnseenShards): string | null {
  const all = [...unseen.unreadable, ...unseen.partial];
  if (all.length === 0) return null;
  const more = all.length > 5 ? `, and ${all.length - 5} more` : "";
  return `${all.length} store shard(s) cannot be read in full (${all.slice(0, 5).join(", ")}${more})`;
}
