/**
 * Read facade for Brain log events over a date range (design D5, D14,
 * task 2.10): the `log-event` records of the `log` stream on a store-only
 * machine, the log day files (`readLogDay`) on an unswitched one, in the
 * shape `readLogDay` returns its entries.
 *
 * The store side reads only the shards whose month can hold an event of
 * the range: a shard is named by the UTC month of its records' clocks,
 * and an event's date is the date its timestamp is written in. An event
 * is written at or after its timestamp (a backfill or an import writes
 * old events today), so every shard from the month before the range on
 * is read; older shards cannot hold one. That is the selection the index
 * `records` table would make (it keys records by shard and clock but
 * holds no body), without opening the index; a reader that needs an
 * index-wide query keeps using search. Events are ordered by timestamp,
 * then fold order.
 *
 * Like the legacy reader, a payload value that is neither a string nor a
 * list of strings is left out of the returned body.
 */

import { listLogShardFiles, readLogDay, type LogShardFile } from "../../brain/log-jsonl.ts";
import type { BrainLogEntry } from "../../brain/log.ts";
import type { BrainLogEventKind } from "../../brain/types.ts";
import { LOG_EVENT_KIND, STORE_PARTITIONS, type StorePartition } from "../constants.ts";
import { compareRecords, type StoreRecord } from "../envelope.ts";
import { readSource, type ReadContext } from "./read-context.ts";
import { readStreamRecords } from "./stream-read.ts";

/** An inclusive range of `YYYY-MM-DD` dates. */
export interface LogDateRange {
  readonly from: string;
  readonly to: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertRange(range: LogDateRange): void {
  if (!DATE_RE.test(range.from) || !DATE_RE.test(range.to)) {
    throw new Error(`log date range must be YYYY-MM-DD dates, got ${range.from}..${range.to}`);
  }
}

/**
 * The legacy day files in `range`: the days that exist, never every
 * calendar day, with the shard listing they came from (`Brain/log/` is
 * listed once, then handed to every `readLogDay`).
 */
function legacyDates(
  vault: string,
  range: LogDateRange,
): { dates: string[]; shards: LogShardFile[] } {
  const shards = listLogShardFiles(vault);
  const dates = [...new Set(shards.map((f) => f.date))]
    .filter((date) => date >= range.from && date <= range.to)
    .toSorted();
  return { dates, shards };
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function entryOf(record: StoreRecord): BrainLogEntry | null {
  const {
    timestamp,
    event_type: eventType,
    body,
  } = record.body as {
    timestamp?: unknown;
    event_type?: unknown;
    body?: unknown;
  };
  if (typeof timestamp !== "string" || typeof eventType !== "string") return null;
  const payload: Record<string, string | ReadonlyArray<string>> = {};
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === "string") payload[k] = v;
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) payload[k] = v;
    }
  }
  const agent = typeof payload["agent"] === "string" ? payload["agent"] : undefined;
  return {
    timestamp,
    eventType: eventType as BrainLogEventKind,
    ...(agent !== undefined ? { agent } : {}),
    body: Object.freeze(payload),
  };
}

/** Every log event dated within `range` (inclusive), oldest first. */
export function readLogEvents(range: LogDateRange, context: ReadContext = {}): BrainLogEntry[] {
  return readLogEventsReport(range, context).entries;
}

/** {@link readLogEvents}, with the store shards that could not be read. */
export interface LogEventsRead {
  readonly entries: BrainLogEntry[];
  /** `<partition>/<shard>` of every store shard skipped: the answer may be short. */
  readonly unreadable: ReadonlyArray<string>;
}

/**
 * {@link readLogEvents} for a caller that must know the answer is whole:
 * a locked or corrupt store shard makes the read shorter, never a throw,
 * and `unreadable` names it.
 */
export function readLogEventsReport(range: LogDateRange, context: ReadContext = {}): LogEventsRead {
  assertRange(range);
  if (range.from > range.to) return { entries: [], unreadable: [] };
  const source = readSource(context);
  if (source.kind === "legacy") {
    const { dates, shards } = legacyDates(source.vault, range);
    const entries = dates.flatMap((date) => [...readLogDay(source.vault, date, shards).entries]);
    return { entries, unreadable: [] };
  }
  const read = storeLogEvents(range, source.store);
  return { entries: read.dated.map((d) => d.entry), unreadable: read.unreadable };
}

/** One store log event with the device that wrote it (a day file's shard id). */
export interface StoreLogEvent {
  readonly entry: BrainLogEntry;
  readonly device: string;
  /** The record's clock: grows with every append of its device, whatever the entry's timestamp. */
  readonly hlc: string;
  /**
   * The partition the record was read from. A record id present in both
   * partitions reads as `private`: the strict answer when devices disagree.
   */
  readonly partition: StorePartition;
}

/**
 * {@link readStoreLogEvents} with the store shards that could not be read:
 * the answer may be short, and `unreadable` names every skipped shard as
 * `<partition>/<shard>`. `null` on an unswitched machine, whose callers
 * keep the day files. A caller that must know the answer is whole (an
 * exporter, the manifest counts) refuses when `unreadable` is not empty.
 */
export function readStoreLogEventsReport(
  range: LogDateRange,
  context: ReadContext = {},
): { events: StoreLogEvent[]; unreadable: ReadonlyArray<string> } | null {
  assertRange(range);
  const source = readSource(context);
  if (source.kind === "legacy") return null;
  if (range.from > range.to) return { events: [], unreadable: [] };
  const read = storeLogEvents(range, source.store);
  return {
    events: read.dated.map((d) => ({
      entry: d.entry,
      device: d.record.device,
      hlc: d.record.hlc,
      partition: d.partition,
    })),
    unreadable: read.unreadable,
  };
}

/**
 * The log events of `range` with their writing device, on a store-only
 * machine; `null` on an unswitched one, whose readers keep the day files
 * and their shard ids (`readLogDay`). For readers that filter by device.
 */
export function readStoreLogEvents(
  range: LogDateRange,
  context: ReadContext = {},
): StoreLogEvent[] | null {
  return readStoreLogEventsReport(range, context)?.events ?? null;
}

function storeLogEvents(
  range: LogDateRange,
  store: Extract<ReturnType<typeof readSource>, { kind: "store" }>["store"],
): {
  dated: Array<{ entry: BrainLogEntry; record: StoreRecord; partition: StorePartition }>;
  unreadable: string[];
} {
  if (store === null) return { dated: [], unreadable: [] };
  const first = shiftMonth(range.from.slice(0, 7), -1);
  // The records of both partitions by record id: a record appended to
  // `private` and copied (or synced) into `shared` counts once, as
  // `private` - the strict answer when devices disagree.
  const byId = new Map<string, { record: StoreRecord; partition: StorePartition }>();
  const unreadable: string[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    const read = readStreamRecords(
      store.root,
      partition,
      { stream: "log" },
      {
        month: (m) => m >= first,
      },
    );
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
    for (const record of read.records) {
      if (record.kind !== LOG_EVENT_KIND) continue;
      const prior = byId.get(record.id);
      if (prior !== undefined && (prior.partition === "private" || partition !== "private")) {
        continue;
      }
      byId.set(record.id, { record, partition });
    }
  }
  const dated: Array<{ entry: BrainLogEntry; record: StoreRecord; partition: StorePartition }> = [];
  for (const { record, partition } of byId.values()) {
    const read = entryOf(record);
    if (read === null) continue;
    const entry: BrainLogEntry =
      partition === "private" ? { ...read, fromPrivatePartition: true } : read;
    const date = entry.timestamp.slice(0, 10);
    if (date >= range.from && date <= range.to) dated.push({ entry, record, partition });
  }
  const sorted = dated.toSorted(
    (a, b) =>
      (a.entry.timestamp < b.entry.timestamp
        ? -1
        : a.entry.timestamp > b.entry.timestamp
          ? 1
          : 0) || compareRecords(a.record, b.record),
  );
  return { dated: sorted, unreadable };
}
