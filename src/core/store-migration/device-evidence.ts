/**
 * The evidence of life of each device (change stale-device-retirement,
 * design D1, D2), read-only, for the pure rule in `device-silence.ts`:
 *
 *  - **Legacy shards.** Every per-device JSONL ledger the migration
 *    catalogue maps is named `<base>.<device>.<ext>`. A base that is a day
 *    (`2026-11-01`) dates the shard at that day, 00:00 UTC; a month
 *    (`2026-11`) at its first day; an ISO week (`2026-W45`) at its
 *    Monday; a fixed stem carries no date. That date is only a floor: the
 *    rows' own time fields ({@link isRowTimeField}, ISO 8601 strings) are
 *    read from the end of each shard, where an append-only ledger keeps
 *    its newest rows: the last {@link TAIL_BYTES}, widened until it holds
 *    the whole newest row, and the newest of them dates the device when it
 *    is later than the name's period.
 *  - **Store records.** The physical part of the clock of the newest
 *    record a device wrote, in every partition this machine holds.
 *  - **Cohort records.** The clock of the earliest `migration-cohort`
 *    record naming a device: the stand-in for a device with no dated trace.
 *
 * File modification times are never read: the sync tool rewrites them.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { parseShardedName } from "../brain/ledger-shards.ts";
import { parseHlc } from "../store/hlc.ts";
import { newestRecordOfEachDevice, type NewestRecords } from "../store/newest-records.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { migrationCatalogue } from "./catalogue.ts";
import type { Locator } from "./destinations.ts";

/** The row fields that carry the time a legacy row was written. */
export const ROW_TIME_FIELDS = Object.freeze([
  "ts",
  "timestamp",
  "time",
  "at",
  "created_at",
  "recorded_at",
  "run_at",
  "written_at",
] as const);

/**
 * The words of a field name that make it a time still to come (a
 * schedule, a reminder, an expiry, a sunset, a not-before): such a field
 * says nothing of when the row was written. Read from the product's
 * writers: `snoozed_at` (a trigger snoozed then), `run_at` (a metrics
 * run) and `planned_at` (a revert plan made then) are past-facing.
 */
const FUTURE_TIME_WORDS: ReadonlySet<string> = new Set([
  "expire",
  "expires",
  "expiry",
  "until",
  "retry",
  "next",
  "due",
  "lands",
  "deadline",
  "schedule",
  "scheduled",
  "remind",
  "reminder",
  "fire",
  "fires",
  "before",
  "starts",
  "sunset",
  "wake",
  "wakes",
]);

/** The lower-case words of a snake or camel case name. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split("_")
    .filter((w) => w !== "");
}

/**
 * Whether a top-level row field carries the time the row was written:
 * one of {@link ROW_TIME_FIELDS}, or any `*_at` / `*At` field (every
 * ledger writer's convention, snake or camel case: the continuity ledger's
 * `createdAt`, the decision ledger's `recordedAt`), except one a word of
 * which names a time still to come ({@link FUTURE_TIME_WORDS}). A field
 * wrongly counted can only date a device later, the safe side: a device is
 * retired later, never earlier.
 */
export function isRowTimeField(name: string): boolean {
  if ((ROW_TIME_FIELDS as readonly string[]).includes(name)) return true;
  if (!/^[a-z][a-zA-Z0-9]*(?:_at|At)$|^[a-z][a-z0-9_]*_at$/.test(name)) return false;
  return !nameWords(name).some((w) => FUTURE_TIME_WORDS.has(w));
}

/** How much of the end of each legacy shard is read for row times. */
export const TAIL_BYTES = 64 * 1024;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

/** The date a shard's base name carries, in ms, or null. */
export function baseDateMs(base: string): number | null {
  const day = DAY_RE.exec(base);
  if (day !== null) {
    const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isFinite(ms) ? ms : null;
  }
  const month = MONTH_RE.exec(base);
  if (month !== null) {
    const ms = Date.UTC(Number(month[1]), Number(month[2]) - 1, 1);
    return Number.isFinite(ms) ? ms : null;
  }
  const week = WEEK_RE.exec(base);
  if (week !== null) {
    // ISO 8601: week 1 holds January 4th; weeks start on Monday.
    const year = Number(week[1]);
    const n = Number(week[2]);
    if (n < 1 || n > 53) return null;
    const jan4 = Date.UTC(year, 0, 4);
    const mondayOfWeek1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
    return mondayOfWeek1 + (n - 1) * 7 * 86_400_000;
  }
  return null;
}

/** The newest row time in `text` (JSONL), or null. */
export function newestRowTimeMs(text: string): number | null {
  let newest: number | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    for (const [field, value] of Object.entries(row as Record<string, unknown>)) {
      if (!isRowTimeField(field)) continue;
      if (typeof value !== "string" || !ISO_RE.test(value)) continue;
      const ms = Date.parse(value);
      if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
    }
  }
  return newest;
}

/**
 * The end of a regular file from its first whole line, at least
 * {@link TAIL_BYTES} and always the whole last row: a last row longer than
 * the window widens it (doubling) until a line break before that row is
 * in it, so the newest row is never cut off; null when unreadable.
 */
function tailOf(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    for (let window = TAIL_BYTES; ; window *= 2) {
      const start = Math.max(0, stat.size - window);
      const buffer = Buffer.alloc(stat.size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, read).toString("utf8");
      if (start === 0) return text;
      const cut = text.indexOf("\n");
      // A break that is not the last row's own terminator: the last row starts in the window.
      if (cut !== -1 && cut < text.trimEnd().length) return text.slice(cut + 1);
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Every device a legacy per-device shard of `vault` names, with its newest
 * dated trace in ms (null for a device whose shards carry no date and no
 * row time).
 */
export function legacyDeviceEvidence(vault: string): Map<string, number | null> {
  return new Map(legacyDeviceEvidenceRead(vault).evidence);
}

/** The legacy evidence, and the devices a legacy shard of which could not be read. */
export interface LegacyDeviceEvidence {
  readonly evidence: ReadonlyMap<string, number | null>;
  /** Devices whose newest legacy trace may be in a shard that could not be read. */
  readonly uncertain: ReadonlySet<string>;
  /**
   * A folder of per-device shards could not be listed: any device may have
   * a trace in it, so no device is judged silent on this read.
   */
  readonly allUncertain: boolean;
}

/**
 * {@link legacyDeviceEvidence} with what it could not read: a shard name
 * whose file cannot be read (a permission, an I/O error) or is a link or
 * special file, and a shard folder that cannot be listed. The legacy
 * evidence decides whether a device is retired by silence, which lets the
 * legacy tree leave the vault, so a trace that could not be read is never
 * taken for no trace.
 */
export function legacyDeviceEvidenceRead(vault: string): LegacyDeviceEvidence {
  const out = new Map<string, number | null>();
  const uncertain = new Set<string>();
  let allUncertain = false;
  const note = (device: string, ms: number | null): void => {
    const seen = out.get(device) ?? null;
    out.set(device, ms === null ? seen : seen === null ? ms : Math.max(seen, ms));
  };
  const list = (dir: string): Dirent[] => {
    const entries = listDirChecked(dir);
    if (entries === null) {
      allUncertain = true;
      return [];
    }
    return entries;
  };
  const jsonl = migrationCatalogue(vault)
    .flatMap((entry) => entry.locators)
    .filter((l): l is Extract<Locator, { shape: "jsonl" }> => l.shape === "jsonl");
  const visited = new Set<string>();
  for (const locator of jsonl) {
    const dirs = locator.subdirs
      ? list(locator.dir)
          .filter((e) => e.isDirectory())
          .map((e) => join(locator.dir, e.name))
      : [locator.dir];
    for (const dir of dirs) {
      for (const entry of list(dir)) {
        const parsed = parseShardedName(entry.name, locator.grammar);
        if (parsed === null || parsed.shardId === "") continue;
        if (!entry.isFile()) {
          // A link or special file under a shard name: its rows are not read.
          if (!entry.isDirectory()) uncertain.add(parsed.shardId);
          continue;
        }
        const path = join(dir, entry.name);
        if (visited.has(path)) continue;
        visited.add(path);
        note(parsed.shardId, baseDateMs(parsed.base));
        if (parsed.ext !== "jsonl") continue;
        const tail = tailOf(path);
        if (tail === null) {
          uncertain.add(parsed.shardId);
          continue;
        }
        note(parsed.shardId, newestRowTimeMs(tail));
      }
    }
  }
  return { evidence: out, uncertain, allUncertain };
}

/** The entries of a directory, none when it does not exist, null when it cannot be listed. */
function listDirChecked(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : null;
  }
}

/** Each device's newest store clock, and the devices whose clock may be short. */
export interface StoreDeviceEvidence {
  readonly evidence: ReadonlyMap<string, number>;
  /**
   * Devices with a shard this machine could not read whole: their newest
   * record may be one it did not see, so silence cannot be judged for them.
   */
  readonly uncertain: ReadonlySet<string>;
}

/**
 * The newest clock (physical ms) of the records each device wrote, over the
 * held partitions, exactly as a fold of every record finds it
 * (`../store/newest-records.ts`), with the devices it cannot tell for.
 */
export function storeDeviceEvidence(
  store: Pick<StoreHandle, "root" | "partitions">,
  read: NewestRecords = newestRecordOfEachDevice(store),
): StoreDeviceEvidence {
  const evidence = new Map<string, number>();
  for (const [device, record] of read.newest) {
    const physical = parseHlc(record.hlc)?.physical;
    if (physical !== undefined) evidence.set(device, physical);
  }
  return { evidence, uncertain: read.uncertain };
}
