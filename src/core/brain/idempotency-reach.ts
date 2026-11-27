/**
 * The idempotency receipt ledger below local reach (change
 * `lane-reach-residuals`, design R1).
 *
 * A receipt says what an earlier keyed call wrote: the signal id, its
 * path, a summary id, the payload hash. One held in `private` was written
 * by an operation the caller below local reach may not read, so neither a
 * dedupe answer built from it nor a mismatch naming its hash may reach
 * that caller, and answering "unseen" instead would let a retry write the
 * operation a second time. Below local reach a key whose first row is held
 * in `private` is therefore refused with the fixed answer of the lane
 * rule, before any answer or write. While the `private` ledger may miss a
 * row (a shard that cannot be read, or is gone since this machine read
 * it, or a row whose body is still a pending blob), the caller's key may
 * match the row that cannot be read, so every keyed call below local
 * reach is refused the same way (fail closed). A local caller, and a
 * machine without `private`, read the ledger as before.
 *
 * The ledger is read here per partition with `readStreamRecords`, keeping
 * each row's partition and each partition's unreadable shards:
 * `readLedgerRowsByDevice` answers no partition, drops what it cannot read
 * unless asked to be strict, and the strict form throws for an unreadable
 * `shared` shard too, which the reach rule does not refuse.
 */

import { privateWithheld } from "../store/caller-reach.ts";
import { LEDGER_ROW_KIND, STORE_PARTITIONS, type StorePartition } from "../store/constants.ts";
import { DUAL_WRITE_LEDGERS } from "../store/dual-write-records.ts";
import { compareRecords, type StoreRecord } from "../store/envelope.ts";
import { LaneEntryWithheldError } from "../store/lane-reach-guard.ts";
import { readSource } from "../store/read/read-context.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import type { StoreInspection } from "../store/store-open.ts";

/** One receipt row and the partition its record is held in. */
interface PartitionedRow {
  readonly row: unknown;
  readonly partition: StorePartition;
}

/** The receipt rows of every held partition in fold order, and whether `private` may miss one. */
interface PartitionedReceipts {
  readonly rows: ReadonlyArray<PartitionedRow>;
  readonly privateMayMiss: boolean;
}

function readReceipts(store: StoreInspection): PartitionedReceipts {
  const records: Array<{ readonly record: StoreRecord; readonly partition: StorePartition }> = [];
  const seen = new Set<string>();
  let privateMayMiss = false;
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    const read = readStreamRecords(store.root, partition, {
      stream: "ledgers",
      ledger: DUAL_WRITE_LEDGERS.idempotency,
    });
    if (partition === "private" && (read.unreadable.length > 0 || read.pendingBlobs.length > 0)) {
      privateMayMiss = true;
    }
    for (const record of read.records) {
      if (record.kind !== LEDGER_ROW_KIND || seen.has(record.id)) continue;
      seen.add(record.id);
      records.push({ record, partition });
    }
  }
  const rows = records
    .toSorted((a, b) => compareRecords(a.record, b.record))
    .flatMap(({ record, partition }) => {
      const row = record.body["row"];
      return row !== null && typeof row === "object" ? [{ row, partition }] : [];
    });
  return { rows, privateMayMiss };
}

/**
 * Below local reach on a store-only machine holding `private`, the first
 * receipt row `matches` accepts, or `null` for none; throws
 * {@link LaneEntryWithheldError} when that row is held in `private` or the
 * `private` ledger may miss a row. `undefined` outside that scope: the
 * caller reads the ledger as before.
 */
export function receiptMatchAtReach<Row>(
  vault: string | null,
  matches: (row: Row) => boolean,
): Row | null | undefined {
  if (!privateWithheld()) return undefined;
  const source = readSource({ vault });
  if (source.kind === "legacy" || source.store === null) return undefined;
  if (!source.store.partitions.has("private")) return undefined;
  const receipts = readReceipts(source.store);
  if (receipts.privateMayMiss) throw new LaneEntryWithheldError();
  const found = receipts.rows.find((entry) => matches(entry.row as Row));
  if (found === undefined) return null;
  if (found.partition === "private") throw new LaneEntryWithheldError();
  return found.row as Row;
}
