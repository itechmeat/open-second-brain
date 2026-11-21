/**
 * `o2b brain migrate-store --dry-run` (task 2.2, design D11): what a
 * migration of this vault into the brain store would do, computed from the
 * legacy tree alone and written nowhere.
 *
 * The report names:
 *
 *  - the devices seen in the legacy tree: the cohort (every device id in a
 *    legacy shard name, with no age limit) and the roster (those whose
 *    shards changed in the last {@link DIGEST_ROSTER_WINDOW_DAYS} days);
 *  - per surface and lane: its planned destination, how many files, bytes
 *    and items it holds, and for a stream how many of those items each
 *    partition would receive under the phase 1 privacy rules;
 *  - every item that cannot be read as its surface writes it, with its
 *    path and line;
 *  - what the sync tool's conflict copies and temp files would become
 *    (`sync-leftovers.ts`): per surface the rows or files imported as
 *    records, those identical to their original that add nothing, the
 *    copies kept in the backup and not imported (each named), the copies
 *    dropped with their original's rule, and the temp files ignored;
 *  - every legacy file or folder no mapping covers. Any such entry fails
 *    the dry run (`ok: false`). A conflict copy whose original a mapping
 *    covers, and a sync temp file, is never one.
 *
 * It never writes: no store, no index, no cache, no lock, no log event.
 */

import { SEARCHABLE_STORE_STREAMS } from "../search/brain-store/constants.ts";
import { estimateIndexBuild } from "../search/index-estimate.ts";
import { join, relative, sep } from "node:path";

import { DIGEST_ROSTER_WINDOW_DAYS } from "../store/constants.ts";
import {
  describeDestination,
  DESTINATION_KIND,
  type Destination,
  type Locator,
} from "./destinations.ts";
import {
  itemPartition,
  itemRecords,
  legacyRootNames,
  migrationCatalogue,
  recordDestination,
  type CatalogueEntry,
} from "./catalogue.ts";
import { endPrivacyBatchChunk, withPrivacyBatch } from "../store/reference-privacy.ts";
import { IMPORT_BATCH_ITEMS } from "./import-batch.ts";
import { unclaimedEntries, type UnmappedEntry } from "./legacy-claims.ts";
import {
  CANNOT_LIST_PREFIX,
  emptyTally,
  scanCopyLines,
  scanLocator,
  type ScanTally,
} from "./legacy-scan.ts";
import { fileCopyVerdicts, judgeCopyFile, recordsSignature } from "./convert.ts";
import {
  findSyncLeftovers,
  SYNC_COPY_RULE,
  SyncCopyTally,
  type SyncCopyReport,
  type SyncLeftovers,
} from "./sync-leftovers.ts";

/** The most unparseable items a report lists one by one. */
export const DRY_RUN_PROBLEM_LIST_CAP = 500;

const DAY_MS = 86_400_000;

/** Partition counts of one stream surface. */
export interface PartitionCounts {
  shared: number;
  private: number;
  "private-when-held": number;
}

/** One surface or lane in the report. */
export interface SurfaceReport {
  readonly id: string;
  readonly label: string;
  readonly source: "state-surface" | "lane";
  /** Vault-relative location, `/`-separated. */
  readonly path: string;
  readonly destination: DestinationSummary;
  readonly planned: string;
  readonly present: boolean;
  readonly files: number;
  readonly bytes: number;
  readonly items: number;
  /** Store records sent to the search index's document stream. */
  readonly searchable_documents: number;
  /** Per-partition item counts; null for a surface that is not a stream. */
  readonly partitions: PartitionCounts | null;
  readonly unparseable: number;
}

export interface DestinationSummary {
  readonly to: Destination["to"];
  readonly stream?: string;
  readonly ledger?: string | null;
  readonly kind?: string;
  readonly partition?: string;
}

export interface DeviceReport {
  readonly device: string;
  readonly files: number;
  readonly items: number;
  readonly last_seen: string;
  readonly in_roster: boolean;
}

export interface UnparseableReport {
  readonly surface: string;
  readonly path: string;
  readonly line: number | null;
  readonly reason: string;
}

export interface MigrationDryRun {
  readonly dry_run: true;
  /**
   * True when every legacy entry has a mapping and every folder of the
   * tree could be listed: a folder the dry run could not read may hold
   * entries no mapping covers, so the plan cannot say it covers them.
   */
  readonly ok: boolean;
  /**
   * Folders of the legacy tree that could not be listed (a permission, an
   * I/O error), vault-relative; each also counts as an unparseable item.
   */
  readonly unreadable_folders: ReadonlyArray<string>;
  readonly vault: string;
  readonly devices: {
    readonly roster_window_days: number;
    readonly cohort: ReadonlyArray<DeviceReport>;
    readonly roster: ReadonlyArray<string>;
    readonly unsharded_files: number;
  };
  readonly surfaces: ReadonlyArray<SurfaceReport>;
  readonly unparseable: ReadonlyArray<UnparseableReport>;
  /** Unparseable items beyond {@link DRY_RUN_PROBLEM_LIST_CAP}. */
  readonly unparseable_not_listed: number;
  readonly unmapped: ReadonlyArray<UnmappedEntry>;
  /** What the sync tool's conflict copies and temp files would become. */
  readonly sync_copies: SyncCopyReport & {
    readonly store_records_imported: number;
    readonly searchable_documents_imported: number;
  };
  readonly totals: {
    readonly items: number;
    readonly unparseable: number;
    readonly unmapped: number;
  };
  /**
   * What the search index built from the store after the switch is
   * expected to take (`search/index-estimate.ts`): the records the items
   * of a stream or blob surface become (an item of a dropped, backed-up,
   * device-local or vault-file surface becomes none, so `store_records`
   * can be below `totals.items`), and the items of a searchable stream an
   * indexed document. The vault's notes are not counted and come on top.
   */
  readonly search_index_estimate: {
    readonly store_records: number;
    readonly documents: number;
    readonly bytes: number;
    readonly seconds: number;
  };
}

function summarize(destination: Destination): DestinationSummary {
  if (destination.to === DESTINATION_KIND.stream) {
    return {
      to: destination.to,
      stream: destination.stream,
      ledger: destination.ledger,
      kind: destination.kind,
      partition: destination.partition,
    };
  }
  if (destination.to === DESTINATION_KIND.blob) {
    return { to: destination.to, partition: destination.partition };
  }
  return { to: destination.to };
}

function vaultRel(vault: string, path: string): string {
  return relative(vault, path).split(sep).join("/");
}

function scanEntry(
  vault: string,
  entry: CatalogueEntry,
  families: ReadonlyMap<string, Set<string>>,
  chunk: () => void,
): { tally: ScanTally; partitions: PartitionCounts | null; records: number; documents: number } {
  const tally = emptyTally();
  let records = 0;
  let documents = 0;
  // Every item the scan reaches counts toward the chunk, as in the pass.
  tally.onVisit = chunk;
  const destination = recordDestination(entry);
  const partitions: PartitionCounts | null =
    destination === null ? null : { shared: 0, private: 0, "private-when-held": 0 };
  for (const locator of entry.locators) {
    scanLocator(locator, tally, (item) => {
      if (destination === null || partitions === null) return;
      const built = itemRecords(vault, destination, item);
      partitions[itemPartition(built)] += 1;
      families.get(item.path)?.add(recordsSignature(built));
      records += built.length;
      if (isSearchableDestination(destination)) documents += built.length;
    });
  }
  return { tally, partitions, records, documents };
}

/**
 * What the conflict copies would become, as the migration's pass decides
 * it (`convert.ts`): a JSONL copy's row is imported unless its original
 * or an earlier copy holds the same records; a whole-file copy is
 * identical, kept, or (its original gone) imported.
 */
function planSyncCopies(
  vault: string,
  leftovers: SyncLeftovers,
  families: ReadonlyMap<string, Set<string>>,
  onProblem: (surface: string, problem: ScanTally["problems"][number]) => void,
): SyncCopyReport & {
  readonly store_records_imported: number;
  readonly searchable_documents_imported: number;
} {
  const copies = new SyncCopyTally(leftovers.temps, leftovers.inFolders);
  let storeRecordsImported = 0;
  let searchableDocumentsImported = 0;
  const fileVerdicts = fileCopyVerdicts(leftovers.copies);
  for (const copy of leftovers.copies) {
    copies.copy(copy);
    if (copy.rule === SYNC_COPY_RULE.dropped) {
      copies.dropped(copy);
      continue;
    }
    const destination = recordDestination(copy.entry);
    if (copy.rule === SYNC_COPY_RULE.rows && destination !== null) {
      const family = families.get(copy.original)!;
      // A row the migration could not read is reported as it reports it.
      const tally = emptyTally();
      // Matched against the original and the earlier copies, as the pass does.
      const mine: string[] = [];
      scanCopyLines(copy.locator, copy.path, copy.original, tally, (item) => {
        const built = itemRecords(vault, destination, item);
        const signature = recordsSignature(built);
        if (family.has(signature)) {
          copies.identical(copy);
          return;
        }
        mine.push(signature);
        copies.imported(copy);
        storeRecordsImported += built.length;
        if (isSearchableDestination(destination)) searchableDocumentsImported += built.length;
      });
      for (const signature of mine) family.add(signature);
      for (const problem of tally.problems) onProblem(copy.entry.id, problem);
      continue;
    }
    const verdict =
      destination === null
        ? judgeCopyFile({ ...copy, rule: SYNC_COPY_RULE.document })
        : (fileVerdicts.get(copy.path) ?? judgeCopyFile(copy));
    if (verdict.kind === "identical") copies.identical(copy);
    else if (verdict.kind === "kept") copies.kept(copy, verdict.reason);
    else if (destination === null) copies.kept(copy, "its original is gone");
    else {
      try {
        const built = itemRecords(vault, destination, verdict.item);
        copies.imported(copy);
        storeRecordsImported += built.length;
        if (isSearchableDestination(destination)) searchableDocumentsImported += built.length;
      } catch (error) {
        copies.kept(copy, (error as Error).message);
      }
    }
  }
  return {
    ...copies.report(),
    store_records_imported: storeRecordsImported,
    searchable_documents_imported: searchableDocumentsImported,
  };
}

function isSearchableDestination(destination: ReturnType<typeof recordDestination>): boolean {
  return (
    destination?.to === DESTINATION_KIND.stream &&
    SEARCHABLE_STORE_STREAMS.has(destination.stream as never)
  );
}

export interface MigrationDryRunOptions {
  /** The clock the roster window is measured against; defaults to now. */
  readonly nowMs?: number;
}

/** Plan the migration of `vault` without writing anything. */
export function planMigrationDryRun(
  vault: string,
  options: MigrationDryRunOptions = {},
): MigrationDryRun {
  // One operation over every legacy row: the privacy judges share their
  // per-vault work across the rows (`withPrivacyBatch`).
  return withPrivacyBatch(() => planDryRun(vault, options));
}

function planDryRun(vault: string, options: MigrationDryRunOptions): MigrationDryRun {
  const nowMs = options.nowMs ?? Date.now();
  const surfaces: SurfaceReport[] = [];
  const unparseable: UnparseableReport[] = [];
  const devices = new Map<string, { files: number; items: number; lastSeenMs: number }>();
  const allLocators: Locator[] = [];
  let unshardedFiles = 0;
  let problems = 0;
  const unreadableFolders = new Set<string>();
  let items = 0;
  let storeRecords = 0;

  const catalogue = migrationCatalogue(vault);
  const leftovers = findSyncLeftovers(vault, catalogue);
  const families = new Map<string, Set<string>>();
  for (const copy of leftovers.copies) {
    if (copy.rule === SYNC_COPY_RULE.rows) families.set(copy.original, new Set());
  }
  // A page-reference verdict is never older than one import batch's worth
  // of rows, as in the migration's pass (`endPrivacyBatchChunk`).
  let rows = 0;
  const chunk = (): void => {
    rows += 1;
    if (rows % IMPORT_BATCH_ITEMS === 0) endPrivacyBatchChunk();
  };
  for (const entry of catalogue) {
    allLocators.push(...entry.locators);
    const { tally, partitions, records, documents } = scanEntry(vault, entry, families, chunk);
    storeRecords += records;
    for (const [device, seen] of tally.devices) {
      const total = devices.get(device) ?? { files: 0, items: 0, lastSeenMs: 0 };
      total.files += seen.files;
      total.items += seen.items;
      total.lastSeenMs = Math.max(total.lastSeenMs, seen.lastSeenMs);
      devices.set(device, total);
    }
    unshardedFiles += tally.unshardedFiles;
    problems += tally.problems.length;
    items += tally.items;
    for (const problem of tally.problems) {
      if (problem.line === null && problem.reason.startsWith(CANNOT_LIST_PREFIX)) {
        unreadableFolders.add(vaultRel(vault, problem.path));
      }
    }
    for (const problem of tally.problems) {
      if (unparseable.length >= DRY_RUN_PROBLEM_LIST_CAP) break;
      unparseable.push({ surface: entry.id, ...problem, path: vaultRel(vault, problem.path) });
    }
    surfaces.push({
      id: entry.id,
      label: entry.label,
      source: entry.source,
      path: vaultRel(vault, entry.primary),
      destination: summarize(entry.mapping.destination),
      planned: describeDestination(entry.mapping.destination),
      present: tally.files > 0,
      files: tally.files,
      bytes: tally.bytes,
      items: tally.items,
      searchable_documents: documents,
      partitions,
      unparseable: tally.problems.length,
    });
  }

  const syncCopies = planSyncCopies(vault, leftovers, families, (surface, problem) => {
    problems += 1;
    const row = surfaces.find((s) => s.id === surface);
    if (row !== undefined)
      surfaces[surfaces.indexOf(row)] = { ...row, unparseable: row.unparseable + 1 };
    if (unparseable.length < DRY_RUN_PROBLEM_LIST_CAP) {
      unparseable.push({ surface, ...problem, path: vaultRel(vault, problem.path) });
    }
  });

  const unmapped = unclaimedEntries(
    vault,
    legacyRootNames(vault, catalogue).map((top) => join(vault, top)),
    allLocators,
  );
  const windowStart = nowMs - DIGEST_ROSTER_WINDOW_DAYS * DAY_MS;
  const cohort: DeviceReport[] = [...devices.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([device, seen]) => ({
      device,
      files: seen.files,
      items: seen.items,
      last_seen: new Date(seen.lastSeenMs).toISOString(),
      in_roster: seen.lastSeenMs >= windowStart,
    }));

  return {
    dry_run: true,
    ok: unmapped.length === 0 && unreadableFolders.size === 0,
    unreadable_folders: [...unreadableFolders].toSorted(),
    vault,
    devices: {
      roster_window_days: DIGEST_ROSTER_WINDOW_DAYS,
      cohort,
      roster: cohort.filter((d) => d.in_roster).map((d) => d.device),
      unsharded_files: unshardedFiles,
    },
    surfaces,
    unparseable,
    unparseable_not_listed: problems - unparseable.length,
    unmapped,
    sync_copies: syncCopies,
    totals: { items, unparseable: problems, unmapped: unmapped.length },
    search_index_estimate: searchIndexEstimate(
      storeRecords + syncCopies.store_records_imported,
      surfaces.reduce((sum, surface) => sum + surface.searchable_documents, 0) +
        syncCopies.searchable_documents_imported,
    ),
  };
}

/** The dry run's estimate of the index the switch rebuilds from the store. */
function searchIndexEstimate(
  storeRecords: number,
  documents: number,
): MigrationDryRun["search_index_estimate"] {
  const estimate = estimateIndexBuild({ storeRecords, documents, noteFiles: null });
  return {
    store_records: storeRecords,
    documents,
    bytes: estimate.bytes,
    seconds: estimate.seconds,
  };
}
