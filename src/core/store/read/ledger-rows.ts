/**
 * Read facade for the rows of one per-device ledger (design D14, task
 * 2.10): the `ledger-row` records of `ledgers/<name>` on a store-only
 * machine, the ledger's legacy files on an unswitched one.
 *
 * Every legacy ledger keeps its own file layout and row parser, so the
 * legacy side is the ledger's own reader, passed by the caller (the
 * module that owns the ledger already exports it). The store side is the
 * same for every ledger: the rows of every held partition in fold order
 * (FORMAT.md, "Order and folds"), each row as its writer wrote it.
 */

import { compareRecords, type StoreRecord } from "../envelope.ts";
import { LEDGER_ROW_KIND, STORE_PARTITIONS } from "../constants.ts";
import { LEDGER_NAME_RE } from "../store-paths.ts";
import { protectionStoreUnavailable } from "./protection-store.ts";
import { readSource, type ReadContext } from "./read-context.ts";
import { readStreamRecords } from "./stream-read.ts";

/** The legacy reader of one ledger: its rows in the vault, oldest first. */
export type LegacyLedgerReader<Row> = (vault: string) => ReadonlyArray<Row>;

/** How a ledger read treats a shard it cannot see. */
export interface LedgerReadOptions {
  /**
   * Throw {@link LedgerUnreadableError} when a shard of the ledger cannot
   * be read or is gone since this machine read it, for a ledger whose
   * empty answer would be a wrong answer (an accountability ledger). By
   * default such a shard is left out.
   */
  readonly strict?: boolean;
}

/** A strict ledger read met a shard it cannot see. */
export class LedgerUnreadableError extends Error {
  constructor(
    readonly ledger: string,
    readonly shards: ReadonlyArray<string>,
  ) {
    super(
      `the ${ledger} ledger cannot be read in full: ${shards.join(", ")} cannot be read or is ` +
        "gone since this machine read it",
    );
    this.name = "LedgerUnreadableError";
  }
}

/** Every row of ledger `name`, oldest first. */
export function readLedgerRows<Row = unknown>(
  name: string,
  legacy: LegacyLedgerReader<Row>,
  context: ReadContext = {},
  options: LedgerReadOptions = {},
): Row[] {
  return readLedgerRowsByDevice(name, legacy, context, options).map((entry) => entry.row);
}

/** One row of a ledger and the device that wrote it (`null` for a legacy row). */
export interface LedgerRowEntry<Row> {
  readonly row: Row;
  readonly device: string | null;
}

/**
 * {@link readLedgerRows} with the device that appended each store row, for
 * a reader whose legacy merge keeps each device shard's own order (the
 * legacy rows carry no device: their reader already merged the shards).
 */
export function readLedgerRowsByDevice<Row = unknown>(
  name: string,
  legacy: LegacyLedgerReader<Row>,
  context: ReadContext = {},
  options: LedgerReadOptions = {},
): LedgerRowEntry<Row>[] {
  if (!LEDGER_NAME_RE.test(name)) throw new Error(`"${name}" is not a ledger name`);
  const source = readSource(context);
  if (source.kind === "legacy") return legacy(source.vault).map((row) => ({ row, device: null }));
  if (source.store === null) {
    // A strict reader on a switched machine whose store cannot be opened:
    // the rows are unknown, never none (`protection-store.ts`).
    const gone = options.strict === true ? protectionStoreUnavailable(context.configPath) : null;
    if (gone !== null) throw new LedgerUnreadableError(name, ["the store"]);
    return [];
  }
  const records: StoreRecord[] = [];
  const seen = new Set<string>();
  for (const partition of STORE_PARTITIONS) {
    if (!source.store.partitions.has(partition)) continue;
    const read = readStreamRecords(source.store.root, partition, {
      stream: "ledgers",
      ledger: name,
    });
    if (options.strict === true && read.unreadable.length > 0) {
      throw new LedgerUnreadableError(
        name,
        read.unreadable.map((rel) => `${partition}/${rel}`),
      );
    }
    for (const record of read.records) {
      if (record.kind !== LEDGER_ROW_KIND || seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
  }
  // A record without a row (malformed, or a future version's) is no row.
  return records
    .toSorted(compareRecords)
    .filter((record) => record.body["row"] !== undefined)
    .map((record) => ({ row: record.body["row"] as Row, device: record.device }));
}
