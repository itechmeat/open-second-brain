/**
 * The import of legacy items into the store in batches (design D11 step 5).
 *
 * An item is planned when the pass reads it: the partition it goes to, and
 * each of its records either matched to a dual-written copy the store
 * already holds or left to append. Planned items are written together
 * once {@link IMPORT_BATCH_ITEMS} wait, and at the end of the pass: every
 * record they lack goes to the store in one batch append (`appendRecords`:
 * one clock write, and one write and one fsync per shard it touches), then
 * every item's journal row in one journal append.
 *
 * Exactly once stays as it was: a record is in the store before its
 * journal row, and it carries the `migrated` mark that names its item, so
 * a run killed anywhere in a batch leaves records the resumed run reads
 * back from the store (`journalFromStore`) and never imports twice, and
 * journal rows it did not write yet.
 */

import { appendRecords, PartitionUnavailableError, type AppendInput } from "../store/appender.ts";
import { endPrivacyBatchChunk } from "../store/reference-privacy.ts";
import { VAULT_ID_FIELD, type StorePartition } from "../store/constants.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import type { StoreHandle } from "../store/store-open.ts";
import type { LegacyItem } from "./destinations.ts";
import { appendJournalRows, journalSet, type Journal, type JournalRow } from "./journal.ts";
import type { JournalScope } from "./journal-scope.ts";
import { LEGACY_DEVICE_FIELD, MIGRATED_FIELD } from "./migration-records.ts";

/** How many planned items wait before they are written. */
export const IMPORT_BATCH_ITEMS = 512;

/** What a batch needs of the pass it serves. */
export interface ImportBatchContext {
  readonly store: StoreHandle;
  readonly vaultId: string | null;
  readonly agent: string;
  readonly dir: string;
  readonly journal: Journal;
  readonly scope: JournalScope;
  /** Take the dual-written copy that stands in for a record, if any. */
  readonly matchCopy: (record: DualWriteRecord) => { id: string; sum: string } | undefined;
  readonly partitionFor: (records: ReadonlyArray<DualWriteRecord>) => StorePartition;
  readonly afterItemAppended?: () => void;
  readonly afterPartAppended?: (part: number, parts: number) => void;
  /** Called after each shard's lines of a batch are written (fault injection). */
  readonly afterShardAppended?: () => void;
  /** Items per batch; {@link IMPORT_BATCH_ITEMS} when absent. */
  readonly batchItems?: number;
  /** Called after a batch is journaled, with how many items it held. */
  readonly afterFlush?: (items: number) => void;
}

interface Planned {
  readonly key: string;
  readonly sum: string;
  readonly partition: StorePartition;
  readonly ids: string[];
  readonly sums: string[];
  /** Part index to the input appended for it. */
  readonly writes: Array<{ readonly part: number; readonly input: AppendInput }>;
}

export class ImportBatch {
  private planned: Planned[] = [];

  constructor(private readonly ctx: ImportBatchContext) {}

  /**
   * Plan one item. Throws {@link PartitionUnavailableError}, before
   * anything of the item is planned to be written, when a record it lacks
   * belongs to a partition this machine does not hold.
   */
  plan(
    item: LegacyItem,
    records: ReadonlyArray<DualWriteRecord>,
    key: string,
    sum: string,
    known: JournalRow | undefined,
  ): void {
    const ctx = this.ctx;
    const partition = known?.partition ?? ctx.partitionFor(records);
    const parts = records.length;
    const ids = Array.from({ length: parts }, (_, i) => known?.ids[i] ?? "");
    const sums = Array.from({ length: parts }, (_, i) => known?.sums[i] ?? "");
    const legacyDevice = item.shape === "line" ? item.device : "";
    const writes: Planned["writes"] = [];
    for (const [part, record] of records.entries()) {
      if (ids[part] !== "") continue;
      const copy = ctx.matchCopy(record);
      if (copy !== undefined) {
        ids[part] = copy.id;
        sums[part] = copy.sum;
        continue;
      }
      if (!ctx.store.partitions.has(partition)) {
        throw new PartitionUnavailableError(partition, ctx.store.root);
      }
      const agent =
        record.agent !== undefined && record.agent.trim() !== "" ? record.agent : ctx.agent;
      writes.push({
        part,
        input: {
          partition,
          stream: record.stream,
          ...(record.ledger !== undefined ? { ledger: record.ledger } : {}),
          kind: record.kind,
          agent,
          scope: record.scope ?? null,
          body: {
            ...record.body,
            [VAULT_ID_FIELD]: ctx.vaultId,
            [LEGACY_DEVICE_FIELD]: legacyDevice,
            [MIGRATED_FIELD]: { key, sum, part, parts, vault: ctx.scope.vault },
          },
        },
      });
    }
    this.planned.push({ key, sum, partition, ids, sums, writes });
    if (this.planned.length >= Math.max(1, this.ctx.batchItems ?? IMPORT_BATCH_ITEMS)) this.flush();
  }

  /** Write every planned item: its records, then its journal row. */
  flush(): void {
    const batch = this.planned;
    if (batch.length === 0) return;
    this.planned = [];
    const ctx = this.ctx;
    const inputs = batch.flatMap((p) => p.writes.map((w) => w.input));
    const written = appendRecords(
      ctx.store,
      inputs,
      ctx.afterShardAppended !== undefined ? { afterShard: ctx.afterShardAppended } : {},
    );
    let at = 0;
    for (const p of batch) {
      for (const w of p.writes) {
        const { record } = written[at]!;
        at += 1;
        p.ids[w.part] = record.id;
        p.sums[w.part] = record.sum;
        ctx.afterPartAppended?.(w.part, p.ids.length);
      }
      ctx.afterItemAppended?.();
    }
    const rows: JournalRow[] = batch.map((p) => ({
      key: p.key,
      sum: p.sum,
      ids: p.ids,
      sums: p.sums,
      partition: p.partition,
      vault: ctx.scope.vault,
    }));
    appendJournalRows(ctx.dir, rows);
    for (const row of rows) journalSet(ctx.journal, row);
    ctx.afterFlush?.(rows.length);
    // A verdict on a page reference is never older than one batch.
    endPrivacyBatchChunk();
  }
}
