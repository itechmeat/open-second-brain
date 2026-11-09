/**
 * The operational log as days, on either side of the switch (design D14,
 * task 2.10): the day files of `Brain/log/` on an unswitched machine, the
 * store's `log-event` records grouped by the date their timestamp names on
 * a store-only one.
 *
 * A store-only read takes the whole `log` stream, so a reader that asks
 * once per preference (the dream pass's evidence collection) would re-read
 * it for every preference. A read pass ({@link withLogReadPass}) keeps the
 * grouped days of each store it read, and hands them back while the
 * store's `log` shards are unchanged (their sizes and mtimes), so an event
 * appended during the pass is seen. The cache lives only inside a pass and
 * holds a few stores at most; outside a pass every call reads.
 */

import { legacyVaultOf } from "./no-vault.ts";
import { statSync } from "node:fs";

import { STORE_PARTITIONS } from "../store/constants.ts";
import { readStoreLogEvents } from "../store/read/log-events.ts";
import { readSource } from "../store/read/read-context.ts";
import { listShards } from "../store/shard-list.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { partitionDir } from "../store/store-paths.ts";
import type { BrainLogEntry, BrainLogParseWarning } from "./log.ts";
import { listLogDates, listLogShardFiles, readLogDay } from "./log-jsonl.ts";

/** One day of the operational log. */
export interface LogDay {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly entries: ReadonlyArray<BrainLogEntry>;
}

/** Where to read: the machine config of the store root and device id. */
export interface LogDaysContext {
  readonly configPath?: string;
}

/** Every date a store log can name; the facade reads only the shards of held months. */
export const WHOLE_LOG = Object.freeze({ from: "1970-01-01", to: "9998-12-31" });

/** Stores one read pass keeps the days of. */
const PASS_CACHE_LIMIT = 4;

interface CachedDays {
  readonly fingerprint: string;
  readonly days: LogDay[];
}

/** The open read pass's cache, by store root and vault; `null` outside a pass. */
let passCache: Map<string, CachedDays> | null = null;

/** How the store log was read, for diagnostics: whole-stream reads and cache hits. */
const stats = { storeReads: 0, cacheHits: 0 };

/**
 * Counters of store log reads since the process started: `storeReads`
 * whole-stream reads, `cacheHits` answers a read pass served from its
 * cache. They let an operator (and a test) see that a pass reads the log
 * once.
 */
export function logReadStats(): { readonly storeReads: number; readonly cacheHits: number } {
  return { ...stats };
}

/**
 * Run `fn` as one read pass: store log reads inside it are cached per
 * store and served again while the log shards are unchanged. Passes nest:
 * an inner pass shares the outer one's cache, and the cache is dropped
 * when the outermost pass ends, also when `fn` throws.
 */
export function withLogReadPass<T>(fn: () => T): T {
  if (passCache !== null) return fn();
  passCache = new Map();
  try {
    return fn();
  } finally {
    passCache = null;
  }
}

function logFingerprint(store: StoreInspection): string {
  const parts: string[] = [store.storeId];
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    for (const shard of listShards(partitionDir(store.root, partition), { stream: "log" })) {
      let stamp = "missing";
      try {
        const stat = statSync(shard.path);
        stamp = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        // a shard removed between the listing and the stat reads as changed
      }
      parts.push(`${partition}/${shard.rel}=${stamp}`);
    }
  }
  return parts.join("\n");
}

function readDays(readContext: { vault: string | null; configPath?: string }): LogDay[] {
  stats.storeReads += 1;
  // The store-only facade, never the one that falls back to the day files:
  // a vault that grew a `Brain/` since the caller resolved the source would
  // otherwise walk every date of WHOLE_LOG one day file at a time.
  const events = readStoreLogEvents(WHOLE_LOG, readContext) ?? [];
  // Frozen: a read pass hands the same days to every reader in it.
  return Object.freeze([...groupByDay(events.map((e) => e.entry)).values()]) as LogDay[];
}

/**
 * The operational log as days, oldest first, read from the `log-event`
 * records on a store-only machine; `null` on an unswitched machine, where
 * the caller reads the day files (`listLogDates`, `readLogDay`).
 */
export function storeLogDays(vault: string | null, context: LogDaysContext = {}): LogDay[] | null {
  const readContext = {
    vault,
    ...(context.configPath !== undefined ? { configPath: context.configPath } : {}),
  };
  const source = readSource(readContext);
  if (source.kind === "legacy") return null;
  if (passCache === null || source.store === null) return readDays(readContext);
  const key = `${source.store.root}\u0000${vault}`;
  const fingerprint = logFingerprint(source.store);
  const cached = passCache.get(key);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    stats.cacheHits += 1;
    return cached.days;
  }
  const days = readDays(readContext);
  if (!passCache.has(key) && passCache.size >= PASS_CACHE_LIMIT) {
    const oldest = passCache.keys().next().value;
    if (oldest !== undefined) passCache.delete(oldest);
  }
  passCache.set(key, { fingerprint, days });
  return days;
}

/** The operational log, read one day at a time. */
export interface LogDayReader {
  /** Whether the days come from the store (a store-only machine). */
  readonly stored: boolean;
  /** Every `YYYY-MM-DD` with an event, oldest first. */
  readonly dates: ReadonlyArray<string>;
  /** The events of one day, oldest first; none for a day with no event. */
  day(date: string): { readonly entries: ReadonlyArray<BrainLogEntry> };
}

/** A {@link logDayReader} limited to the days a reader can use. */
export interface LogDayReaderOptions extends LogDaysContext {
  /** First `YYYY-MM-DD` the reader asks for (inclusive); open when absent. */
  readonly from?: string;
  /** Last `YYYY-MM-DD` the reader asks for (inclusive); open when absent. */
  readonly to?: string;
}

function groupByDay(entries: ReadonlyArray<BrainLogEntry>): Map<string, LogDay> {
  const days = new Map<string, BrainLogEntry[]>();
  for (const entry of entries) {
    const date = entry.timestamp.slice(0, 10);
    const list = days.get(date);
    if (list === undefined) days.set(date, [entry]);
    else list.push(entry);
  }
  return new Map(
    [...days.keys()]
      .toSorted()
      .map((date) => [date, Object.freeze({ date, entries: Object.freeze(days.get(date) ?? []) })]),
  );
}

/**
 * The entries grouped by the date their timestamp names, oldest first:
 * the same frozen days `storeLogDays` returns, for a caller that has
 * already read the events itself (the OKF export's shared-only days).
 */
export function groupLogDays(entries: ReadonlyArray<BrainLogEntry>): LogDay[] {
  return [...groupByDay(entries).values()];
}

/**
 * The log of `vault` for a reader that walks it by day: the day files
 * (`listLogDates`, `readLogDay`) on an unswitched machine, the store's
 * `log-event` records on a store-only one (read once per read pass).
 *
 * The store log is read only when it is first needed. A reader with a
 * `from`/`to` window reads the shards that can hold those days, and so
 * does a single `day()` asked outside a read pass; walking the open
 * `dates` reads the whole log once.
 */
export function logDayReader(
  vault: string | null,
  options: LogDayReaderOptions = {},
): LogDayReader {
  const context: LogDaysContext =
    options.configPath !== undefined ? { configPath: options.configPath } : {};
  const readContext = { vault, ...context };
  const inRange = (date: string): boolean =>
    (options.from === undefined || date >= options.from) &&
    (options.to === undefined || date <= options.to);
  if (readSource(readContext).kind === "legacy") {
    const root = legacyVaultOf(vault, "logDayReader");
    // The date list walks the log folder, so it is read only when asked
    // for: a reader of one day (`osb://log/{date}`) never lists them all.
    let dates: ReadonlyArray<string> | undefined;
    return {
      stored: false,
      get dates() {
        return (dates ??= listLogDates(root).filter(inRange));
      },
      day: (date) => readLogDay(root, date),
    };
  }
  const windowed = options.from !== undefined || options.to !== undefined;
  let byDate: Map<string, LogDay> | null = null;
  const load = (): Map<string, LogDay> => {
    if (byDate !== null) return byDate;
    if (windowed && passCache === null) {
      stats.storeReads += 1;
      const range = { from: options.from ?? WHOLE_LOG.from, to: options.to ?? WHOLE_LOG.to };
      byDate = groupByDay((readStoreLogEvents(range, readContext) ?? []).map((e) => e.entry));
    } else {
      byDate = new Map((storeLogDays(vault, context) ?? []).map((d) => [d.date, d] as const));
    }
    return byDate;
  };
  return {
    stored: true,
    get dates() {
      return [...load().keys()].filter(inRange);
    },
    day: (date) => {
      // A window bounds the dates listed, not the days answered: a day
      // outside it is read on its own, as the legacy reader reads any day.
      // (A read pass caches the whole log, which holds every day.)
      if (windowed && passCache === null && !inRange(date)) {
        const events = readStoreLogEvents({ from: date, to: date }, readContext) ?? [];
        return { entries: events.map((e) => e.entry) };
      }
      if (byDate !== null || passCache !== null || windowed) {
        return load().get(date) ?? { entries: [] };
      }
      const events = readStoreLogEvents({ from: date, to: date }, readContext) ?? [];
      return { entries: events.map((e) => e.entry) };
    },
  };
}

/** One day of the log with the device (a day file's shard id) of each entry. */
export interface LogDayWithDevices {
  readonly date: string;
  readonly entries: ReadonlyArray<BrainLogEntry>;
  /** Parallel to `entries`: the shard id of a day file, the device of a store record. */
  readonly entryShardIds: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<BrainLogParseWarning>;
  /**
   * Parallel to `entries`, store records only: each record's clock, which
   * orders one device's events by append whatever their timestamps say.
   */
  readonly entryHlcs?: ReadonlyArray<string>;
}

/**
 * The log by day with each entry's device, for readers that filter or
 * group by device: the day files and their shard ids on an unswitched
 * machine, the store's `log-event` records and their devices on a
 * store-only one. Days outside `[fromDate, toDate]` (inclusive
 * `YYYY-MM-DD`, either open) are not read.
 */
export function logDaysWithDevices(
  vault: string,
  fromDate: string | null,
  toDate: string | null,
  context: LogDaysContext = {},
): LogDayWithDevices[] {
  const inRange = (date: string): boolean =>
    (fromDate === null || date >= fromDate) && (toDate === null || date <= toDate);
  const stored = readStoreLogEvents(
    { from: fromDate ?? WHOLE_LOG.from, to: toDate ?? WHOLE_LOG.to },
    { vault, ...(context.configPath !== undefined ? { configPath: context.configPath } : {}) },
  );
  if (stored === null) {
    const shards = listLogShardFiles(vault);
    return listLogDates(vault)
      .filter(inRange)
      .map((date) => {
        const day = readLogDay(vault, date, shards);
        return {
          date,
          entries: day.entries,
          entryShardIds: day.entryShardIds,
          warnings: day.warnings,
        };
      });
  }
  const byDate = new Map<string, { entries: BrainLogEntry[]; devices: string[]; hlcs: string[] }>();
  for (const event of stored) {
    const date = event.entry.timestamp.slice(0, 10);
    const day = byDate.get(date) ?? { entries: [], devices: [], hlcs: [] };
    day.entries.push(event.entry);
    day.devices.push(event.device);
    day.hlcs.push(event.hlc);
    byDate.set(date, day);
  }
  return [...byDate.keys()].toSorted().map((date) => ({
    date,
    entries: byDate.get(date)!.entries,
    entryShardIds: byDate.get(date)!.devices,
    entryHlcs: byDate.get(date)!.hlcs,
    warnings: [],
  }));
}
