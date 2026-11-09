/**
 * The migration catalogue of one vault: every mapped location (the
 * `STATE_SURFACES` rows first, then the Brain lanes), each with the
 * locators its items are found by. The dry run and the migration walk the
 * same catalogue, so what one plans is what the other moves.
 *
 * The catch-all record lane (`lane-map.ts`, `catchAll`) takes every page
 * and JSON file below `Brain/` that no other location reads; its locator
 * is given the others' locators to exclude here, once.
 */

import { relative, sep } from "node:path";

import { STATE_SURFACES } from "../state/surfaces.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import {
  makesRecords,
  type LegacyItem,
  type Locator,
  type RecordDestination,
  type SurfaceMapping,
} from "./destinations.ts";
import { LEGACY_LANES } from "./lane-map.ts";
import { SURFACE_MAP } from "./surface-map.ts";

export interface CatalogueEntry {
  readonly id: string;
  readonly label: string;
  readonly source: "state-surface" | "lane";
  readonly primary: string;
  readonly mapping: SurfaceMapping;
  readonly locators: ReadonlyArray<Locator>;
}

/** The partition a record goes to, before this machine's holdings are known. */
export type PlannedPartition = "shared" | "private" | "private-when-held";

/** Every mapped location of `vault`, with its locators. */
export function migrationCatalogue(vault: string): CatalogueEntry[] {
  const raw = [
    ...STATE_SURFACES.map((surface) => ({
      id: surface.id,
      label: surface.label,
      source: "state-surface" as const,
      primary: surface.derive(vault, null),
      mapping: SURFACE_MAP[surface.id],
      catchAll: false,
    })),
    ...LEGACY_LANES.map((lane) => ({
      id: lane.id,
      label: lane.label,
      source: "lane" as const,
      primary: lane.root(vault),
      mapping: lane.mapping,
      catchAll: lane.catchAll === true,
    })),
  ];
  const locate = (entry: {
    readonly primary: string;
    readonly mapping: SurfaceMapping;
  }): ReadonlyArray<Locator> =>
    entry.mapping.locate?.(vault, entry.primary) ?? [{ shape: "tree", path: entry.primary }];
  const others = raw.filter((e) => !e.catchAll).flatMap((e) => locate(e));
  return raw.map(({ catchAll, ...entry }) => ({
    ...entry,
    locators: catchAll
      ? locate(entry).map((l) => (l.shape === "entries" ? { ...l, exclude: others } : l))
      : locate(entry),
  }));
}

/**
 * The vault folders legacy state lives in: the top folder of every
 * catalogued location (`Brain/` and the derived store beside it).
 */
export function legacyRootNames(vault: string, catalogue: ReadonlyArray<CatalogueEntry>): string[] {
  const tops = new Set<string>();
  for (const entry of catalogue) {
    const top = relative(vault, entry.primary).split(sep)[0];
    if (top !== undefined && top !== "" && top !== "..") tops.add(top);
  }
  return [...tops].toSorted();
}

/** The destination of an entry, when its items become records. */
export function recordDestination(entry: CatalogueEntry): RecordDestination | null {
  const destination = entry.mapping.destination;
  return makesRecords(destination) ? destination : null;
}

/** The records one item becomes; throws when it becomes none. */
export function itemRecords(
  vault: string,
  destination: RecordDestination,
  item: LegacyItem,
): ReadonlyArray<DualWriteRecord> {
  const built = destination.record(vault, item);
  let records: ReadonlyArray<DualWriteRecord> = [];
  if (Array.isArray(built)) records = built;
  else if (built !== null) records = [built as DualWriteRecord];
  if (records.length === 0) throw new Error("holds nothing a record would carry");
  return records;
}

/**
 * The planned partition of a record, by the dual-write rule: private when
 * marked so or when the body carries a private region, private-when-held
 * when marked so, else shared.
 */
export function plannedPartition(record: DualWriteRecord): PlannedPartition {
  if (record.private === true || valueCarriesPrivateRegion(record.body)) return "private";
  return record.privateWhenHeld === true ? "private-when-held" : "shared";
}

/**
 * The partition of a set of records that came from one item: all of them
 * land where the most private one would, so an item never splits.
 */
export function itemPartition(records: ReadonlyArray<DualWriteRecord>): PlannedPartition {
  const planned = new Set(records.map(plannedPartition));
  if (planned.has("private")) return "private";
  return planned.has("private-when-held") ? "private-when-held" : "shared";
}
