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
 *
 * A sync tool's conflict copy of a legacy file (`sync-leftovers.ts`) is
 * read after the whole catalogue, as a version of its original. A row of
 * a JSONL copy whose records (by {@link contentKey}) the original or an
 * earlier copy of it holds adds nothing: it is neither journaled nor
 * imported, so a row present in both is stored once. Any other row is an
 * item of its own under the COPY's key (`<copy path>#<line>`), built as
 * the original's row would be: the copy's name never changes, so the
 * journal, a resumed run, a later machine importing the same copy, the
 * transition import and the rollback (which finds the copy restored with
 * that key and checksum) all see one item, imported once.
 */

import { lstatSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import { PartitionUnavailableError } from "../store/appender.ts";
import { LOG_CHAIN_FIELDS } from "../brain/log.ts";
import { LOG_EVENT_KIND, VAULT_ID_FIELD, type StorePartition } from "../store/constants.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import type { RecordBody, StoreRecord } from "../store/envelope.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { endPrivacyBatchChunk, withPrivacyBatch } from "../store/reference-privacy.ts";
import type { UnparseableItem } from "./backup.ts";
import { itemPartition, itemRecords, migrationCatalogue, recordDestination } from "./catalogue.ts";
import type { LegacyItem } from "./destinations.ts";
import {
  forEachHeldRecord,
  journalClaimedAmong,
  journalGet,
  rowComplete,
  storeRecordSums,
  type Journal,
  type RecordSums,
} from "./journal.ts";
import { dualWriteFromVault, type JournalScope } from "./journal-scope.ts";
import { IMPORT_BATCH_ITEMS, ImportBatch } from "./import-batch.ts";
import { SpillMap, type MigrationScratch, type ReadonlySpillMap } from "./spill-map.ts";
import type { IncrementalReads } from "./incremental-reads.ts";
import { emptyTally, readFileItem, ScanAbort, scanCopyLines, scanLocator } from "./legacy-scan.ts";
import {
  findSyncLeftovers,
  SYNC_COPY_RULE,
  SyncCopyTally,
  type SyncConflictCopy,
  type SyncCopyReport,
} from "./sync-leftovers.ts";
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
  /** Called after each shard's lines of an import batch are written. */
  readonly afterShardAppended?: () => void;
  /** Called when the pass visits an item, before it is imported or skipped (its key). */
  readonly afterItemVisited?: (key: string) => void;
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
  /** Called after each batch of items is journaled, with how many it held. */
  readonly onJournaled?: (items: number) => void;
  /** Items per import batch (`import-batch.ts`); the default when absent. */
  readonly batchItems?: number;
  /**
   * What earlier passes read of each JSONL file (`incremental-reads.ts`),
   * for an import of late legacy writes: unchanged files are skipped,
   * appended ones read from where the last read ended. Absent: every
   * file is read whole.
   */
  readonly incremental?: IncrementalReads;
  /**
   * Where the maps with an entry per legacy item (the items a pass saw)
   * move once they grow (`spill-map.ts`); in memory when absent.
   */
  readonly scratch?: MigrationScratch;
}

export interface PassResult {
  readonly imported: number;
  /** Every legacy item this pass saw: key to content checksum. */
  readonly seen: ReadonlySpillMap;
  readonly problems: ReadonlyArray<UnparseableItem>;
  /** Device ids found in the legacy shard names this pass read. */
  readonly devices: ReadonlySet<string>;
  /** Items left out because they belong to a partition this machine does not hold. */
  readonly heldBack: number;
  /** The `problems` that are items this pass could not parse (not the held-back ones). */
  readonly unparseable: ReadonlyArray<UnparseableItem>;
  /** What the sync tool's conflict copies and temp files became in this pass. */
  readonly syncCopies: SyncCopyReport;
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
  held?: Iterable<StoreRecord>,
): DualWritePool {
  const native = writtenWhileSwitched(store);
  const copies: StoreRecord[] = [];
  const take = (record: StoreRecord): void => {
    if (migratedMark(record) !== null) return;
    if (native(record)) return;
    if (!dualWriteFromVault(scope, record)) return;
    copies.push(record);
  };
  if (held !== undefined) for (const record of held) take(record);
  else {
    // Record by record: only the unmarked copies are kept.
    forEachHeldRecord(store, (_partition, record) => take(record));
  }
  // The journal is walked once for the copies' ids, never held as a set
  // of every id it names.
  const claimed = journalClaimedAmong(journal, new Set(copies.map((record) => record.id)));
  const pool: DualWritePool = new Map();
  for (const record of copies) {
    if (claimed.has(record.id)) continue;
    const key = contentKey(record.kind, record.body);
    const same = pool.get(key);
    if (same === undefined) pool.set(key, [record]);
    else same.push(record);
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

/** The content of the records one item becomes, for matching a copy's row to its original's. */
export function recordsSignature(records: ReadonlyArray<DualWriteRecord>): string {
  return records.map((record) => contentKey(record.kind, record.body)).join("\u0001");
}

/** What a whole-file conflict copy is, next to its original. */
export type CopyFileVerdict =
  | { readonly kind: "identical" }
  | { readonly kind: "kept"; readonly reason: string }
  /** The original is gone: the copy is the only version, imported as the original's item. */
  | { readonly kind: "only"; readonly item: LegacyItem };

/**
 * Whether the file at `path` is there: only ENOENT and ENOTDIR say it is
 * absent; any other error (a permission, an I/O error) leaves it unknown,
 * and its message says why.
 */
function presence(path: string): true | false | { readonly error: string } {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    return { error: (error as Error).message };
  }
}

/**
 * Judge a `file` or `document` conflict copy against its original. A
 * `document` compares bytes; a `file` compares the item its surface
 * reads (`itemSum`), so a copy that differs only in how the same record
 * was written adds nothing. A differing copy is kept: two versions of one
 * record (one signal id, one preference) are an edit conflict a person
 * resolves, never two records.
 */
export function judgeCopyFile(copy: SyncConflictCopy): CopyFileVerdict {
  const there = presence(copy.original);
  // An original that cannot be looked at is not gone: the copy is kept,
  // never taken for the only version.
  if (typeof there === "object") {
    return { kind: "kept", reason: `its original cannot be looked at: ${there.error}` };
  }
  const originalThere = there;
  if (copy.rule === SYNC_COPY_RULE.document) {
    if (!originalThere) return { kind: "kept", reason: "its original is gone" };
    try {
      return readFileSync(copy.path).equals(readFileSync(copy.original))
        ? { kind: "identical" }
        : { kind: "kept", reason: "a second version of a single document" };
    } catch (error) {
      return { kind: "kept", reason: `cannot be read: ${(error as Error).message}` };
    }
  }
  let item: LegacyItem | null;
  try {
    item = readFileItem(copy.locator, copy.original, copy.path);
  } catch (error) {
    return {
      kind: "kept",
      reason: `cannot be read as its surface writes it: ${(error as Error).message}`,
    };
  }
  if (item === null) return { kind: "kept", reason: "its surface holds no item per file" };
  if (!originalThere) return { kind: "only", item };
  let original: LegacyItem | null;
  try {
    original = readFileItem(copy.locator, copy.original, copy.original);
  } catch {
    original = null;
  }
  if (original !== null && itemSum(original) === itemSum(item)) return { kind: "identical" };
  return { kind: "kept", reason: "a second version of one record" };
}

/**
 * The verdict on every whole-file conflict copy (`file` rule) of a pass,
 * the copies of one original judged together: a sole copy of an original
 * that is gone is that item, imported; several copies of one gone
 * original are one item when they all hold the same item (the first is
 * imported, the others are identical), and all kept and none imported
 * when they differ, since none is the record and a person picks.
 */
export function fileCopyVerdicts(
  copies: ReadonlyArray<SyncConflictCopy>,
): Map<string, CopyFileVerdict> {
  const out = new Map<string, CopyFileVerdict>();
  const orphans = new Map<string, SyncConflictCopy[]>();
  for (const copy of copies) {
    if (copy.rule !== SYNC_COPY_RULE.file) continue;
    const verdict = judgeCopyFile(copy);
    out.set(copy.path, verdict);
    if (verdict.kind === "only")
      orphans.set(copy.original, [...(orphans.get(copy.original) ?? []), copy]);
  }
  for (const group of orphans.values()) {
    if (group.length < 2) continue;
    const sums = group.map((copy) => {
      const verdict = out.get(copy.path)!;
      return verdict.kind === "only" ? itemSum(verdict.item) : "";
    });
    if (sums.every((sum) => sum === sums[0])) {
      for (const copy of group.slice(1)) out.set(copy.path, { kind: "identical" });
    } else {
      for (const copy of group) {
        out.set(copy.path, {
          kind: "kept",
          reason: "one of several differing versions of a record whose original is gone",
        });
      }
    }
  }
  return out;
}

/** One pass over the whole catalogue. */
export function convertPass(ctx: ConvertContext): PassResult {
  // One operation over every legacy row: the privacy judges share their
  // per-vault work across the rows (`withPrivacyBatch`).
  return withPrivacyBatch(() => runPass(ctx));
}

function runPass(ctx: ConvertContext): PassResult {
  const seen = ctx.scratch !== undefined ? ctx.scratch.map() : new SpillMap();
  const problems: UnparseableItem[] = [];
  const devices = new Set<string>();
  let imported = 0;
  let heldBack = 0;
  // The scan records a held-back item as a problem too, under its error.
  const heldReasons = new Set<string>();
  const catalogue = migrationCatalogue(ctx.vault);
  const leftovers = findSyncLeftovers(ctx.vault, catalogue);
  // The record contents of every original a JSONL conflict copy is a
  // version of, so a row the copy shares with it is stored once.
  const families = new Map<string, Set<string>>();
  for (const copy of leftovers.copies) {
    if (copy.rule === SYNC_COPY_RULE.rows) families.set(copy.original, new Set());
  }
  const batch = new ImportBatch({
    store: ctx.store,
    vaultId: ctx.vaultId,
    agent: ctx.agent,
    dir: ctx.dir,
    journal: ctx.journal,
    scope: ctx.scope,
    matchCopy: (record) => ctx.pool.get(contentKey(record.kind, record.body))?.shift(),
    partitionFor: (records) => partitionFor(ctx.store, records),
    afterItemAppended: () => {
      imported += 1;
      ctx.hooks?.afterItemAppended?.(imported);
    },
    ...(ctx.hooks?.afterPartAppended !== undefined
      ? { afterPartAppended: ctx.hooks.afterPartAppended }
      : {}),
    ...(ctx.hooks?.afterShardAppended !== undefined
      ? { afterShardAppended: ctx.hooks.afterShardAppended }
      : {}),
    ...(ctx.onJournaled !== undefined ? { afterFlush: ctx.onJournaled } : {}),
    ...(ctx.batchItems !== undefined ? { batchItems: ctx.batchItems } : {}),
  });
  let visited = 0;
  const chunkRows = Math.max(1, ctx.batchItems ?? IMPORT_BATCH_ITEMS);
  /**
   * The one place the pass counts what it visits: every item a scan
   * reaches (`ScanTally.onVisit`: imported, already journaled, identical
   * to its original, unparseable or held back alike), every whole-file
   * conflict copy and every sync temp file. A page-reference verdict is
   * never older than one batch of them.
   */
  const step = (key: string): void => {
    visited += 1;
    if (visited % chunkRows === 0) endPrivacyBatchChunk();
    ctx.hooks?.afterItemVisited?.(key);
  };
  const onVisit = (path: string, line: number | null): void => {
    const rel = relative(ctx.vault, path).split(sep).join("/");
    step(line === null ? rel : `${rel}#${line}`);
  };
  /** Import one item unless the journal holds it completely; throws as a scan visitor does. */
  const importOne = (
    item: LegacyItem,
    records: ReadonlyArray<DualWriteRecord>,
    key: string,
    sum: string,
  ): void => {
    seen.set(key, sum);
    const known = journalGet(ctx.journal, key, sum);
    if (known !== undefined && rowComplete(known)) return;
    try {
      batch.plan(item, records, key, sum, known);
    } catch (error) {
      // A private item on a machine without `private` stays a gap that
      // fails verification; any other failure stops the run.
      if (error instanceof PartitionUnavailableError) {
        heldBack += 1;
        heldReasons.add(error.message);
        throw error;
      }
      throw new ScanAbort(error);
    }
  };
  // An original a conflict copy is a version of is read whole: its rows
  // are what the copy's rows are matched against.
  ctx.incremental?.exclude(families.keys());
  for (const entry of catalogue) {
    const destination = recordDestination(entry);
    if (destination === null) continue;
    const tally = emptyTally();
    tally.onVisit = onVisit;
    if (ctx.incremental !== undefined) tally.incremental = ctx.incremental;
    for (const locator of entry.locators) {
      scanLocator(locator, tally, (item) => {
        const key = itemKey(ctx.vault, item);
        const sum = itemSum(item);
        // An item the journal already holds whole needs no record built
        // and no partition judged: it is skipped by key and checksum. An
        // original a conflict copy is a version of is still built, since
        // its records are what the copy's rows are matched against.
        if (!families.has(item.path)) {
          const known = journalGet(ctx.journal, key, sum);
          if (known !== undefined && rowComplete(known)) {
            seen.set(key, sum);
            return;
          }
        }
        // A shape error here marks the item unparseable: it is archived,
        // not imported, and does not block the migration.
        const records = itemRecords(ctx.vault, destination, item);
        families.get(item.path)?.add(recordsSignature(records));
        importOne(item, records, key, sum);
      });
    }
    for (const problem of tally.problems) problems.push({ surface: entry.id, ...problem });
    for (const device of tally.devices.keys()) devices.add(device);
  }
  const copies = new SyncCopyTally(leftovers.temps, leftovers.inFolders);
  const fileVerdicts = fileCopyVerdicts(leftovers.copies);
  for (const temp of leftovers.temps) step(temp);
  for (const copy of leftovers.copies) {
    copies.copy(copy);
    // A row copy's rows are counted as the scan reaches them.
    if (copy.rule !== SYNC_COPY_RULE.rows) step(copy.rel);
    const destination = recordDestination(copy.entry);
    if (copy.rule === SYNC_COPY_RULE.dropped || destination === null) {
      if (copy.rule === SYNC_COPY_RULE.dropped) copies.dropped(copy);
      else judgeDocument(copy, copies);
      continue;
    }
    const tally = emptyTally();
    tally.onVisit = onVisit;
    if (copy.rule === SYNC_COPY_RULE.rows) {
      const family = families.get(copy.original)!;
      // A row is matched against the original and the earlier copies only:
      // two lines of this copy with the same row are two items, as two
      // lines of the original are. Its rows join the family afterwards.
      const mine: string[] = [];
      scanCopyLines(copy.locator, copy.path, copy.original, tally, (item) => {
        const records = itemRecords(ctx.vault, destination, item);
        const signature = recordsSignature(records);
        if (family.has(signature)) {
          copies.identical(copy);
          return;
        }
        mine.push(signature);
        copies.imported(copy);
        importOne(item, records, itemKey(ctx.vault, { ...item, path: copy.path }), itemSum(item));
      });
      for (const signature of mine) family.add(signature);
    } else {
      const verdict = fileVerdicts.get(copy.path) ?? judgeCopyFile(copy);
      if (verdict.kind === "identical") copies.identical(copy);
      else if (verdict.kind === "kept") copies.kept(copy, verdict.reason);
      else {
        let records: ReadonlyArray<DualWriteRecord>;
        try {
          records = itemRecords(ctx.vault, destination, verdict.item);
        } catch (error) {
          copies.kept(copy, (error as Error).message);
          continue;
        }
        copies.imported(copy);
        const key = itemKey(ctx.vault, { ...verdict.item, path: copy.path });
        try {
          importOne(verdict.item, records, key, itemSum(verdict.item));
        } catch (error) {
          if (error instanceof ScanAbort) throw error.cause;
          tally.problems.push({ path: copy.path, line: null, reason: (error as Error).message });
        }
      }
    }
    for (const problem of tally.problems) problems.push({ surface: copy.entry.id, ...problem });
  }
  try {
    batch.flush();
  } catch (error) {
    throw error instanceof ScanAbort ? error : new ScanAbort(error);
  }
  if (ctx.incremental !== undefined) {
    // A file with a problem (unparseable, or held back) is read whole again.
    for (const problem of problems) ctx.incremental.drop(problem.path);
    ctx.incremental.endPass();
  }
  const unparseable = problems.filter((p) => !heldReasons.has(p.reason));
  return {
    imported,
    seen,
    problems,
    devices,
    heldBack,
    unparseable,
    syncCopies: copies.report(),
  };
}

/** A `document` copy (or a record surface with no item per file): identical or kept. */
function judgeDocument(copy: SyncConflictCopy, copies: SyncCopyTally): void {
  const verdict = judgeCopyFile({ ...copy, rule: SYNC_COPY_RULE.document });
  if (verdict.kind === "identical") copies.identical(copy);
  else copies.kept(copy, verdict.kind === "kept" ? verdict.reason : "its original is gone");
}

/** One legacy item the store does not hold as journaled. */
export interface VerificationGap {
  readonly key: string;
  readonly reason: string;
}

/** Check the last pass's items against the journal and the store. */
export function verifyImport(
  ctx: ConvertContext,
  seen: ReadonlySpillMap,
  inStore: RecordSums = storeRecordSums(ctx.store),
): VerificationGap[] {
  const gaps: VerificationGap[] = [];
  for (const [key, sum] of seen.entries()) {
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
