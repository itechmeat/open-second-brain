/**
 * The import of the legacy items into the store (design D11 steps 5 to
 * 7, D11a): one pass walks the whole catalogue and writes every item whose
 * key and checksum the journal does not hold completely; the final delta
 * pass is the same pass repeated until it imports nothing; verification
 * checks that every legacy item the last pass saw is journaled with its
 * current checksum and that every record the journal names is in the store
 * with the body checksum it was written with.
 *
 * Records are appended under this device's id, each with the vault id,
 * the device of the legacy shard it came from (`legacy_device`, empty for
 * an un-sharded file) and the `migrated` mark of its item (key, checksum,
 * part). The journal reads marks from every device, so a later machine
 * skips what an earlier one imported, and an item cut off between its
 * records is completed part by part.
 *
 * Copies a phase 1 dual write already put in the store are not imported
 * twice. They are matched as a multiset: for each (kind, body without the
 * store-only fields) the unmarked copies of every device are counted, and
 * each item record consumes one before any is appended, so two distinct
 * legacy items with identical content are still both kept. Every device's
 * copies count because the legacy shards are shared: a match leaves no
 * mark in the store, so a later machine that only counted its own copies
 * would import again what the first machine matched to its dual writes.
 * A copy counts only for the vault it was dual-written from
 * (`journal-scope.ts` `dualWriteFromVault`): the content key leaves the
 * vault out, so the pool checks it, and an identical item of another
 * vault gets a record of its own.
 *
 * All the records of one item go to one partition, by the dual-write rule.
 */

import { relative, sep } from "node:path";

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import { appendRecord, PartitionUnavailableError } from "../store/appender.ts";
import { LOG_CHAIN_FIELDS } from "../brain/log.ts";
import { LOG_EVENT_KIND, VAULT_ID_FIELD, type StorePartition } from "../store/constants.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import type { RecordBody, StoreRecord } from "../store/envelope.ts";
import type { StoreHandle } from "../store/store-open.ts";
import type { UnparseableItem } from "./backup.ts";
import { itemPartition, itemRecords, migrationCatalogue, recordDestination } from "./catalogue.ts";
import type { LegacyItem } from "./destinations.ts";
import {
  appendJournal,
  heldRecords,
  journalGet,
  journalIds,
  journalSet,
  rowComplete,
  storeRecordSums,
  type Journal,
  type JournalRow,
} from "./journal.ts";
import { dualWriteFromVault, type JournalScope } from "./journal-scope.ts";
import { emptyTally, ScanAbort, scanLocator } from "./legacy-scan.ts";
import {
  LEGACY_DEVICE_FIELD,
  MIGRATED_FIELD,
  migratedMark,
  writtenWhileSwitched,
} from "./migration-records.ts";

/**
 * Fault-injection points; the CLI never sets them. They stay because a
 * crash test must stop the run at a chosen item: the kill-child test
 * (`tests/core/store-migration/fixtures/kill-child.ts`) SIGKILLs itself
 * here, and a kill sent from outside cannot land on one item of a run that
 * takes milliseconds.
 */
export interface ConvertHooks {
  /** Called after an item's records are appended and before its journal row. */
  readonly afterItemAppended?: (imported: number) => void;
  /** Called after each record of an item is appended (part index). */
  readonly afterPartAppended?: (part: number, parts: number) => void;
}

export interface ConvertContext {
  readonly vault: string;
  readonly store: StoreHandle;
  readonly vaultId: string | null;
  /** The agent named on records whose legacy item names none. */
  readonly agent: string;
  /** The migration's device-local folder, where the journal lives. */
  readonly dir: string;
  /** The journal, updated as items are imported. */
  readonly journal: Journal;
  /** Which vault the run imports, for the journal rows and marks it writes. */
  readonly scope: JournalScope;
  /** The dual-written copies (of any device) not matched yet, by content key. */
  readonly pool: DualWritePool;
  readonly hooks?: ConvertHooks;
}

export interface PassResult {
  readonly imported: number;
  /** Every legacy item this pass saw: key to content checksum. */
  readonly seen: ReadonlyMap<string, string>;
  readonly problems: ReadonlyArray<UnparseableItem>;
  /** Device ids found in the legacy shard names this pass read. */
  readonly devices: ReadonlySet<string>;
  /** Items left out because they belong to a partition this machine does not hold. */
  readonly heldBack: number;
}

/** Unmatched dual-written copies: content key to their records, oldest first. */
export type DualWritePool = Map<string, StoreRecord[]>;

/** Body fields the store adds that a legacy item does not determine. */
const STORE_ONLY_FIELDS = [VAULT_ID_FIELD, MIGRATED_FIELD, LEGACY_DEVICE_FIELD];

export function contentKey(kind: string, body: RecordBody): string {
  const rest: Record<string, unknown> = { ...body };
  for (const field of STORE_ONLY_FIELDS) delete rest[field];
  // A dual-written log event carries its payload without the hash chain
  // the legacy JSONL row adds beside it; compare the payloads alone.
  const inner = rest["body"];
  if (kind === LOG_EVENT_KIND && inner !== null && typeof inner === "object") {
    const payload: Record<string, unknown> = { ...(inner as Record<string, unknown>) };
    for (const field of Object.values(LOG_CHAIN_FIELDS)) delete payload[field];
    rest["body"] = payload;
  }
  return `${kind}\u0000${canonicalJson(rest)}`;
}

/**
 * The records of every device without a `migrated` mark (the dual-written
 * copies), minus those a journal row already matched. A record its device
 * wrote while switched to the store is native, not a dual-written copy, so
 * it never stands in for a legacy item with the same content (that item
 * would be counted as imported and never appended). A copy of another
 * vault never stands in for one of this vault's items either.
 */
export function dualWritePool(
  store: StoreHandle,
  journal: Journal,
  scope: JournalScope,
): DualWritePool {
  const claimed = journalIds(journal);
  const native = writtenWhileSwitched(store);
  const pool: DualWritePool = new Map();
  for (const record of heldRecords(store)) {
    if (migratedMark(record) !== null) continue;
    if (claimed.has(record.id)) continue;
    if (native(record)) continue;
    if (!dualWriteFromVault(scope, record)) continue;
    const key = contentKey(record.kind, record.body);
    pool.set(key, [...(pool.get(key) ?? []), record]);
  }
  return pool;
}

/** The journal key of an item: its vault-relative path, and its line. */
export function itemKey(vault: string, item: LegacyItem): string {
  const path = relative(vault, item.path).split(sep).join("/");
  return item.shape === "line" ? `${path}#${item.line}` : path;
}

/** The checksum of an item's content, independent of how it was serialised. */
export function itemSum(item: LegacyItem): string {
  switch (item.shape) {
    case "line":
      return sha256Hex(canonicalJson(item.row));
    case "json-file":
      return sha256Hex(canonicalJson(item.value));
    case "page":
      return sha256Hex(canonicalJson({ frontmatter: item.frontmatter, body: item.body }));
    case "text":
      return sha256Hex(item.text);
    case "entry":
      return sha256Hex(canonicalJson({ fields: item.fields, text: item.text }));
  }
}

function partitionFor(store: StoreHandle, records: ReadonlyArray<DualWriteRecord>): StorePartition {
  const planned = itemPartition(records);
  if (planned === "private") return "private";
  if (planned === "private-when-held" && store.partitions.has("private")) return "private";
  return "shared";
}

/** Write the parts of an item `known` lacks; returns the completed row. */
function importItem(
  ctx: ConvertContext,
  item: LegacyItem,
  records: ReadonlyArray<DualWriteRecord>,
  key: string,
  sum: string,
  known: JournalRow | undefined,
): JournalRow {
  const partition = known?.partition ?? partitionFor(ctx.store, records);
  const parts = records.length;
  const ids = Array.from({ length: parts }, (_, i) => known?.ids[i] ?? "");
  const sums = Array.from({ length: parts }, (_, i) => known?.sums[i] ?? "");
  const legacyDevice = item.shape === "line" ? item.device : "";
  for (const [part, record] of records.entries()) {
    if (ids[part] !== "") continue;
    const copy = ctx.pool.get(contentKey(record.kind, record.body))?.shift();
    if (copy !== undefined) {
      ids[part] = copy.id;
      sums[part] = copy.sum;
      continue;
    }
    const agent =
      record.agent !== undefined && record.agent.trim() !== "" ? record.agent : ctx.agent;
    const { record: written } = appendRecord(ctx.store, {
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
    });
    ids[part] = written.id;
    sums[part] = written.sum;
    ctx.hooks?.afterPartAppended?.(part, parts);
  }
  return { key, sum, ids, sums, partition, vault: ctx.scope.vault };
}

/** One pass over the whole catalogue. */
export function convertPass(ctx: ConvertContext): PassResult {
  const seen = new Map<string, string>();
  const problems: UnparseableItem[] = [];
  const devices = new Set<string>();
  let imported = 0;
  let heldBack = 0;
  for (const entry of migrationCatalogue(ctx.vault)) {
    const destination = recordDestination(entry);
    if (destination === null) continue;
    const tally = emptyTally();
    for (const locator of entry.locators) {
      scanLocator(locator, tally, (item) => {
        const key = itemKey(ctx.vault, item);
        const sum = itemSum(item);
        // A shape error here marks the item unparseable: it is archived,
        // not imported, and does not block the migration.
        const records = itemRecords(ctx.vault, destination, item);
        seen.set(key, sum);
        const known = journalGet(ctx.journal, key, sum);
        if (known !== undefined && rowComplete(known)) return;
        let row: JournalRow;
        try {
          row = importItem(ctx, item, records, key, sum, known);
          imported += 1;
          ctx.hooks?.afterItemAppended?.(imported);
        } catch (error) {
          // A private item on a machine without `private` stays a gap that
          // fails verification; any other failure stops the run.
          if (error instanceof PartitionUnavailableError) {
            heldBack += 1;
            throw error;
          }
          throw new ScanAbort(error);
        }
        appendJournal(ctx.dir, row);
        journalSet(ctx.journal, row);
      });
    }
    for (const problem of tally.problems) problems.push({ surface: entry.id, ...problem });
    for (const device of tally.devices.keys()) devices.add(device);
  }
  return { imported, seen, problems, devices, heldBack };
}

/** One legacy item the store does not hold as journaled. */
export interface VerificationGap {
  readonly key: string;
  readonly reason: string;
}

/** Check the last pass's items against the journal and the store. */
export function verifyImport(
  ctx: ConvertContext,
  seen: ReadonlyMap<string, string>,
): VerificationGap[] {
  const inStore = storeRecordSums(ctx.store);
  const gaps: VerificationGap[] = [];
  for (const [key, sum] of seen) {
    const row = journalGet(ctx.journal, key, sum);
    if (row === undefined || !rowComplete(row)) {
      gaps.push({ key, reason: "not imported with its current content" });
      continue;
    }
    const missing = row.ids.findIndex((id, i) => inStore.get(id) !== row.sums[i]);
    if (missing !== -1) {
      gaps.push({ key, reason: `record ${row.ids[missing]} is not in the store as written` });
    }
  }
  return gaps.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
