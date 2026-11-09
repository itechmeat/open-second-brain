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
 *  - every legacy file or folder no mapping covers. Any such entry fails
 *    the dry run (`ok: false`).
 *
 * It never writes: no store, no index, no cache, no lock, no log event.
 */

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
import { unclaimedEntries, type UnmappedEntry } from "./legacy-claims.ts";
import { emptyTally, scanLocator, type ScanTally } from "./legacy-scan.ts";

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
  /** True when every legacy entry has a mapping. */
  readonly ok: boolean;
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
  readonly totals: {
    readonly items: number;
    readonly unparseable: number;
    readonly unmapped: number;
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
): { tally: ScanTally; partitions: PartitionCounts | null } {
  const tally = emptyTally();
  const destination = recordDestination(entry);
  const partitions: PartitionCounts | null =
    destination === null ? null : { shared: 0, private: 0, "private-when-held": 0 };
  for (const locator of entry.locators) {
    scanLocator(locator, tally, (item) => {
      if (destination === null || partitions === null) return;
      partitions[itemPartition(itemRecords(vault, destination, item))] += 1;
    });
  }
  return { tally, partitions };
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
  const nowMs = options.nowMs ?? Date.now();
  const surfaces: SurfaceReport[] = [];
  const unparseable: UnparseableReport[] = [];
  const devices = new Map<string, { files: number; items: number; lastSeenMs: number }>();
  const allLocators: Locator[] = [];
  let unshardedFiles = 0;
  let problems = 0;
  let items = 0;

  const catalogue = migrationCatalogue(vault);
  for (const entry of catalogue) {
    allLocators.push(...entry.locators);
    const { tally, partitions } = scanEntry(vault, entry);
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
      partitions,
      unparseable: tally.problems.length,
    });
  }

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
    ok: unmapped.length === 0,
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
    totals: { items, unparseable: problems, unmapped: unmapped.length },
  };
}
