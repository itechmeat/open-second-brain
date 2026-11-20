/**
 * The later-machine side of the migration (task 2.4, design D11 "Later
 * machines"): a machine that migrates after the first one waits until its
 * copy of the store holds every record of the first machine's
 * `migration-done` cut, for each partition it holds. File sync may deliver
 * the completion record before the shards it names; importing then would
 * re-import what the first machine already imported, because the marks
 * that say so have not arrived.
 *
 * A cut entry is satisfied when the local shard holds at least the cut's
 * record count and the cut's last record id (shards only grow). A
 * partition this machine does not hold is skipped and named. A cut whose
 * shape this release cannot read is waited on and named, never skipped.
 */

import { statSync } from "node:fs";

import { sleepSync } from "../fs-atomic.ts";
import { STORE_PARTITIONS, type StorePartition } from "../store/constants.ts";
import { forEachPartitionRecord, type CutEntry } from "../store/state-digest.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { partitionDir } from "../store/store-paths.ts";
import { MIGRATION_DONE_KIND, migrationDoneRecords } from "./migration-records.ts";

export interface CutWait {
  /** `<partition>/<shard>` entries the local store does not hold yet. */
  readonly missing: ReadonlyArray<string>;
  /** Partitions a completion record names that this machine does not hold. */
  readonly skipped: ReadonlyArray<StorePartition>;
  /** Devices whose `migration-done` this machine waited on. */
  readonly firstMachines: ReadonlyArray<string>;
  /**
   * Whether the wait is for the vault's identity marker: this vault has
   * none yet, and another device's migration named the vault it migrated
   * by one. If it is the same vault, sync delivers that marker; minting a
   * second one now would import the whole vault again (`journal-scope.ts`).
   */
  readonly marker?: boolean;
}

function isCutEntry(value: unknown): value is CutEntry {
  if (value === null || typeof value !== "object") return false;
  const { shard, count, last } = value as Record<string, unknown>;
  return (
    typeof shard === "string" &&
    typeof last === "string" &&
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0
  );
}

/**
 * The per-partition cuts of a synced `migration-done` body, or null when
 * any part of it is not the shape this release writes (another device or
 * release wrote it, so nothing about it is trusted).
 */
function cutsOf(value: unknown): Array<[StorePartition, ReadonlyArray<CutEntry>]> | null {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Array<[StorePartition, ReadonlyArray<CutEntry>]> = [];
  for (const [partition, cut] of Object.entries(value as Record<string, unknown>)) {
    if (!(STORE_PARTITIONS as ReadonlyArray<string>).includes(partition)) return null;
    const entries = (cut as { cut?: unknown } | null)?.cut;
    if (!Array.isArray(entries) || !entries.every(isCutEntry)) return null;
    out.push([partition as StorePartition, entries]);
  }
  return out;
}

/** What the store still lacks of every `migration-done` cut it holds. */
export function cutWait(store: StoreHandle, cache: CutShardCache = new Map()): CutWait {
  const missing: string[] = [];
  const skipped = new Set<StorePartition>();
  const firstMachines = new Set<string>();
  // Every cut first: a shard is then read for its count and for only the
  // ids some cut ends on, never for every id it holds.
  const cuts: Array<[StorePartition, ReadonlyArray<CutEntry>]> = [];
  for (const done of migrationDoneRecords(store)) {
    firstMachines.add(done.device);
    const parsed = cutsOf(done.body["cuts"]);
    if (parsed === null) {
      // A cut this release cannot read is waited on, never skipped: the
      // marks it stands for may not have arrived, and importing now would
      // import them twice. The entry names the record to look at.
      missing.push(`${MIGRATION_DONE_KIND} ${done.id} of ${done.device} (unreadable cut)`);
      continue;
    }
    for (const [partition, cut] of parsed) {
      if (!store.partitions.has(partition)) {
        skipped.add(partition);
        continue;
      }
      cuts.push([partition, cut]);
    }
  }
  const wanted = new Map<StorePartition, Set<string>>();
  for (const [partition, cut] of cuts) {
    const ids = wanted.get(partition) ?? new Set<string>();
    for (const entry of cut) ids.add(entry.last);
    wanted.set(partition, ids);
  }
  const local = new Map<StorePartition, Map<string, { count: number; ids: Set<string> }>>();
  const shardsOf = (partition: StorePartition) => {
    let shards = local.get(partition);
    if (shards === undefined) {
      const want = wanted.get(partition) ?? new Set<string>();
      const wantKey = [...want].toSorted().join(",");
      const held = new Map<string, { count: number; ids: Set<string> }>();
      // Record by record, keeping only each shard's count and the wanted
      // ids it holds; a shard whose file is unchanged since the last poll,
      // read for the same ids, is not read again.
      const known = cache.get(partition) ?? new Map<string, CachedCutShard>();
      const next = new Map<string, CachedCutShard>();
      // The stamp is taken before the shard is read: a shard that grows
      // while it is read carries a newer stamp and is read again.
      const stamps = new Map<string, string | null>();
      const reading = new Map<string, { count: number; ids: Set<string> }>();
      forEachPartitionRecord(
        partitionDir(store.root, partition),
        {
          onUnreadable: () => {},
          reuse: ({ rel, path }) => {
            const stamp = fileStampOf(path);
            stamps.set(rel, stamp);
            const hit = known.get(rel);
            if (stamp === null || hit === undefined || hit.stamp !== stamp) return false;
            if (hit.wanted !== wantKey) return false;
            next.set(rel, hit);
            held.set(rel, hit);
            return true;
          },
        },
        {
          record: (shard, record) => {
            let entry = reading.get(shard.rel);
            if (entry === undefined) {
              entry = { count: 0, ids: new Set<string>() };
              reading.set(shard.rel, entry);
            }
            entry.count += 1;
            if (want.has(record.id)) entry.ids.add(record.id);
          },
          shard: (totals) => {
            const read = reading.get(totals.rel) ?? { count: 0, ids: new Set<string>() };
            reading.delete(totals.rel);
            const entry = {
              stamp: stamps.get(totals.rel) ?? null,
              wanted: wantKey,
              count: read.count,
              ids: read.ids,
            };
            if (entry.stamp !== null) next.set(totals.rel, entry);
            held.set(totals.rel, entry);
          },
        },
      );
      cache.set(partition, next);
      shards = held;
      local.set(partition, shards);
    }
    return shards;
  };
  for (const [partition, cut] of cuts) {
    const shards = shardsOf(partition);
    for (const entry of cut) {
      const held = shards.get(entry.shard);
      if (held === undefined || held.count < entry.count || !held.ids.has(entry.last)) {
        missing.push(`${partition}/${entry.shard}`);
      }
    }
  }
  return {
    missing: [...new Set(missing)].toSorted(),
    skipped: [...skipped].toSorted(),
    firstMachines: [...firstMachines].toSorted(),
  };
}

/**
 * {@link cutWait}, polled every `intervalMs` until nothing is missing or
 * `budgetMs` has passed. Returns the last answer.
 */
export function waitForCut(store: StoreHandle, budgetMs: number, intervalMs = 1000): CutWait {
  const deadline = Date.now() + budgetMs;
  // Each poll reads only the shards sync changed since the one before.
  const cache: CutShardCache = new Map();
  let wait = cutWait(store, cache);
  while (wait.missing.length > 0 && Date.now() < deadline) {
    const pause = Math.min(intervalMs, deadline - Date.now());
    if (pause > 0) sleepSync(pause);
    wait = cutWait(store, cache);
  }
  return wait;
}

/** What a poll of {@link cutWait} knew of one shard, by the file's stamp. */
interface CachedCutShard {
  readonly stamp: string | null;
  /** The ids the read looked for, sorted and joined: another set reads the shard again. */
  readonly wanted: string;
  readonly count: number;
  /** The ids looked for that the shard holds. */
  readonly ids: Set<string>;
}

/** Per partition, per shard: what the last poll read. */
export type CutShardCache = Map<StorePartition, Map<string, CachedCutShard>>;

/** `size:mtimeMs:ctimeMs:ino` of a file, or null when it cannot be read. */
function fileStampOf(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  } catch {
    return null;
  }
}
