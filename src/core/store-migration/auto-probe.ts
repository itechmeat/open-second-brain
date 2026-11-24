/**
 * Reads the automatic store migration asks before it acts (change
 * auto-store-migration): what this machine's own migration run left in
 * its device-local state, and what the synced vault says about another
 * device's migration. Read-only; nothing here creates a store, a lock or
 * a directory.
 *
 *  - {@link ownMigrationRunRead}: this device's run state (`state.json` in the
 *    store's device-local migration folder) and whether the device is
 *    switched. A start asks it on a switched machine to find a switch
 *    whose own run did not finish (killed or failed after the
 *    `device-switched` record), which the automatic path finishes; and on
 *    a legacy machine to find a run the operator rolled back, which the
 *    automatic path never redoes on its own.
 *  - {@link otherDeviceMigrationMark}: the synced trace a migration on
 *    another device leaves in this vault before this machine can see that
 *    device's store. The migration snapshots `Brain/` once the gate is
 *    closed and logs a `snapshot` event with the reason `store-migration`;
 *    the Brain log is sharded per device and syncs with the vault, so a
 *    shard of another device holding that event says another device
 *    created (or used) a store for this vault and started migrating it.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";

import { listLogShardFiles } from "../brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_SNAPSHOT_REASON } from "../brain/types.ts";
import { readDeviceId } from "../config.ts";
import { deviceSwitchedHere } from "../store/store-only.ts";
import { inspectStore } from "../store/store-open.ts";
import {
  deviceStateDirFor,
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../store/store-paths.ts";
import {
  migrationDir,
  readMigrationState,
  readRollbackRecord,
  type MigrationStateRead,
  type RollbackRecordRead,
} from "./journal.ts";

/** This device's migration run as its device-local state records it. */
export interface OwnMigrationRun {
  /** The run state as one read of its file found it: absent, unreadable or the run. */
  readonly state: MigrationStateRead;
  /** Whether this device is switched to the configured store. */
  readonly switched: boolean;
  /** This machine's rollback record, read once with the run state. */
  readonly rollback: RollbackRecordRead;
  /** The device-local migration folder of the run. */
  readonly dir: string;
}

/**
 * This device's run against the configured store as one look found it:
 * `absent` when there is no store (no run can be recorded),
 * `unreadable` when the store, the machine config or the device-local
 * folder cannot be read (which says nothing about a run: it could be one
 * the operator rolled back), or the run. A run state file that is there
 * and cannot be read is a run whose `state` is `unreadable`. Cheap: the
 * store's identity files, the sticky switch marker (or this device's
 * `settings` shards) and one small JSON file.
 */
export type OwnMigrationRunRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly error: string }
  | { readonly kind: "run"; readonly run: OwnMigrationRun };

/** This device's run against the configured store ({@link OwnMigrationRunRead}). Never throws. */
export function ownMigrationRunRead(configPath?: string): OwnMigrationRunRead {
  try {
    const root = resolveConfiguredStoreRoot(configPath).root;
    const inspection = inspectStore(root);
    if (inspection === null) return { kind: "absent" };
    const device = readDeviceId(configPath);
    const dir = migrationDir({ deviceStateDir: deviceStateDirFor(inspection.storeId) });
    return {
      kind: "run",
      run: {
        state: readMigrationState(dir),
        switched: device !== null && deviceSwitchedHere(inspection, device),
        rollback: readRollbackRecord(dir),
        dir,
      },
    };
  } catch (err) {
    // A store root inside the vault is a configuration the migration
    // refuses with its own reason: no run can be recorded against it.
    if (err instanceof StoreRootInsideVaultError) return { kind: "absent" };
    return { kind: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
}

/** A switched device whose own run is still `in-progress`: the switch did not finish. */
export function interruptedSwitch(read: OwnMigrationRunRead): boolean {
  return (
    read.kind === "run" &&
    read.run.switched &&
    read.run.state.kind === "state" &&
    read.run.state.state.phase === "in-progress"
  );
}

/** Another device's migration of this vault, as the synced Brain log shows it. */
export interface OtherDeviceMark {
  /** The device whose log shard holds the event. */
  readonly device: string;
  /** The snapshot run id the event names. */
  readonly runId: string;
  /**
   * When the device wrote the mark (its log line's `ts`, epoch ms), or
   * null when the line carries no readable time. A switch record of the
   * device written before it belongs to an earlier migration.
   */
  readonly at: number | null;
}

/**
 * How many of each other device's log shards are read, newest first. A
 * device's migration writes its mark (the snapshot event) as its last
 * legacy log line before it switches, after which it writes no legacy log
 * line at all, so the mark is in its newest shard; two cover a migration
 * that ran over midnight.
 */
export const MARK_SHARDS_PER_DEVICE = 2;

/** How much of the end of each shard read is read: the mark is the shard's last line. */
export const MARK_TAIL_BYTES = 256 * 1024;

/**
 * How many other devices are looked at, by the name of their newest shard
 * (its date first, then the rest of the name). A migrating device whose
 * newest shard sorts below this many others is not read, so its mark is
 * missed and this machine creates a store of its own (design, "the look
 * is bounded").
 */
export const MARK_DEVICES = 32;

/**
 * One shard as the mark scan read it: the read failed (`error`), or the
 * text of its tail. `text` holds whole lines only, from the first line
 * that starts inside the window; `cutStart` says the window began inside
 * a line, whose part in the window is not in `text` (a line that long
 * could not be read back to its start).
 */
export type ShardTail =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly text: string; readonly cutStart: boolean };

/** One log shard of another device, as the listing names it. */
export interface MarkShardFile {
  readonly device: string;
  readonly name: string;
  readonly path: string;
}

/** The Brain log listing the scan starts from: the shard files, or why it failed. */
export type MarkListing =
  | { readonly ok: true; readonly files: ReadonlyArray<MarkShardFile> }
  | { readonly ok: false; readonly error: string };

/**
 * How far before the window a line that the window starts inside is read
 * back to its start. A log line is far shorter; a longer one leaves the
 * window cut ({@link ShardTail}), which the judge counts as a read that
 * could hide a mark.
 */
export const MARK_LINE_LOOKBACK_BYTES = 64 * 1024;

/** Read exactly `length` bytes at `position`, or throw: a short read is a shard that changed. */
function readFully(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buffer, got, length - got, position + got);
    if (n === 0) {
      throw new Error(
        `the shard ended after ${got} of ${length} bytes while it was read (sync replaced it)`,
      );
    }
    got += n;
  }
  return buffer;
}

/**
 * The last `bytes` of a file, whole lines only. A window that starts
 * inside a line is read back to that line's start (at most
 * {@link MARK_LINE_LOOKBACK_BYTES} more), so a mark the window cuts is
 * read whole; a read that comes back short throws.
 */
function tailOf(path: string, bytes: number): ShardTail {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    // From the byte before the window, and further back to the start of
    // the line the window begins inside, when there is one.
    const from = Math.max(0, start - 1 - MARK_LINE_LOOKBACK_BYTES);
    const buffer = readFully(fd, size - from, from);
    if (start === 0) return { ok: true, text: buffer.toString("utf8"), cutStart: false };
    // The newline nearest before the window's first byte starts its first line.
    const window = start - from;
    const newline = buffer.lastIndexOf(0x0a, window - 1);
    if (newline >= 0) {
      return { ok: true, text: buffer.subarray(newline + 1).toString("utf8"), cutStart: false };
    }
    // The line began at the file's start, which was read.
    if (from === 0) return { ok: true, text: buffer.toString("utf8"), cutStart: false };
    // No line start within reach: the window's first line stays unread.
    const next = buffer.indexOf(0x0a, window);
    const text = next < 0 ? "" : buffer.subarray(next + 1).toString("utf8");
    return { ok: true, text, cutStart: true };
  } finally {
    closeSync(fd);
  }
}

/**
 * What the look for another device's mark found: the mark, or none after a
 * scan that read everything it looks at; or `incomplete` (the reason) when
 * a shard or the log folder could not be read, which says nothing about a
 * mark, so the caller creates no store on it.
 */
export interface MarkScan {
  readonly mark: OtherDeviceMark | null;
  readonly incomplete: string | null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The Brain log's shard files of devices other than `device`. Never throws. */
function listMarkShards(vault: string, device: string): MarkListing {
  try {
    const files: MarkShardFile[] = [];
    for (const f of listLogShardFiles(vault)) {
      if (f.ext !== "jsonl" || f.shardId === "" || f.shardId === device) continue;
      files.push({ device: f.shardId, name: basename(f.path), path: f.path });
    }
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}

/** One shard's tail, or the read's failure. Never throws. */
function readMarkShard(path: string): ShardTail {
  try {
    return tailOf(path, MARK_TAIL_BYTES);
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}

/**
 * The newest `store-migration` snapshot event in a log shard of a device
 * other than `device` ({@link MarkScan}). Never throws. The reads are
 * gathered here; what they answer is {@link judgeMarkScan}'s.
 */
export function otherDeviceMigrationMark(vault: string, device: string): MarkScan {
  return judgeMarkScan(listMarkShards(vault, device), device, readMarkShard);
}

/**
 * What the look for another device's mark answers, from the listing and
 * the reads alone (`read` is asked only for the shards the look covers):
 * no file is opened here, and no clock is read.
 *
 * Bounded however many years of shards the vault holds: per other device
 * (at most {@link MARK_DEVICES}, by the name of the newest shard, which
 * begins with its date) only its newest {@link MARK_SHARDS_PER_DEVICE}
 * shards, and of each only the last {@link MARK_TAIL_BYTES}. A line is
 * parsed only when it names the reason. A device that went on writing
 * legacy log lines on later days (its migration did not switch it, or it
 * was rolled back) no longer counts: its store, created before the mark,
 * has had those days to arrive by sync.
 */
export function judgeMarkScan(
  listing: MarkListing,
  device: string,
  read: (path: string) => ShardTail,
): MarkScan {
  const all = judgeMarkScanAll(listing, device, read, true);
  return { mark: all.marks[0] ?? null, incomplete: all.marks.length > 0 ? null : all.incomplete };
}

/** Every other device's mark the bounded look finds ({@link judgeMarkScan}'s rules). */
export interface MarkScanAll {
  readonly marks: ReadonlyArray<OtherDeviceMark>;
  readonly incomplete: string | null;
}

/**
 * The marks of every other device the bounded look covers (not only the
 * newest): which devices of the cohort moved to their store. Never throws.
 */
export function otherDeviceMigrationMarks(vault: string, device: string): MarkScanAll {
  return judgeMarkScanAll(listMarkShards(vault, device), device, readMarkShard, false);
}

function judgeMarkScanAll(
  listing: MarkListing,
  device: string,
  read: (path: string) => ShardTail,
  firstOnly: boolean,
): MarkScanAll {
  if (!listing.ok) {
    return { marks: [], incomplete: `the Brain log cannot be listed (${listing.error})` };
  }
  const byDevice = new Map<string, MarkShardFile[]>();
  for (const f of listing.files) {
    if (f.device === "" || f.device === device) continue;
    const list = byDevice.get(f.device) ?? [];
    list.push(f);
    byDevice.set(f.device, list);
  }
  // Shard names begin with their date, so the name orders them; the path,
  // then the device id, break ties, so the order of the listing never
  // changes the answer.
  const byName = (x: MarkShardFile, y: MarkShardFile): number =>
    x.name !== y.name ? (x.name < y.name ? 1 : -1) : x.path < y.path ? 1 : x.path > y.path ? -1 : 0;
  const newest = [...byDevice.entries()]
    .map(([shardId, list]) => ({ shardId, shards: list.toSorted(byName) }))
    .toSorted((x, y) => byName(x.shards[0]!, y.shards[0]!) || (x.shardId < y.shardId ? -1 : 1))
    .slice(0, MARK_DEVICES);
  let incomplete: string | null = null;
  const marks: OtherDeviceMark[] = [];
  for (const { shardId, shards } of newest) {
    for (const file of shards.slice(0, MARK_SHARDS_PER_DEVICE)) {
      const tail = read(file.path);
      if (!tail.ok) {
        // A mark found elsewhere still answers; none found does not.
        incomplete ??= `the log shard ${file.name} cannot be read (${tail.error})`;
        continue;
      }
      const mark = markIn(tail.text, shardId);
      if (mark !== null) {
        marks.push(mark);
        if (firstOnly) return { marks, incomplete: null };
        break;
      }
      // A window cut at its start, or a last line sync is still writing,
      // may be the mark: the read says nothing about one.
      if (tail.cutStart) {
        incomplete ??= `the log shard ${file.name} has a line too long to read back to its start`;
      } else if (tornLastLine(tail.text)) {
        incomplete ??= `the log shard ${file.name} ends in a line sync is still writing`;
      }
    }
  }
  return { marks, incomplete };
}

/**
 * Whether the text ends in a line that is not whole: no newline after it,
 * and it does not parse. Every log append ends its line with a newline.
 */
function tornLastLine(text: string): boolean {
  if (text === "" || text.endsWith("\n")) return false;
  const last = text.slice(text.lastIndexOf("\n") + 1);
  if (last.trim() === "") return false;
  try {
    JSON.parse(last);
    return false;
  } catch {
    return true;
  }
}

/** The newest `store-migration` snapshot event in the tail of one shard, or null. */
function markIn(text: string, shardId: string): OtherDeviceMark | null {
  if (!text.includes(BRAIN_SNAPSHOT_REASON.storeMigration)) return null;
  for (const line of text.split("\n").toReversed()) {
    if (!line.includes(BRAIN_SNAPSHOT_REASON.storeMigration)) continue;
    try {
      const row = JSON.parse(line) as {
        ts?: unknown;
        kind?: unknown;
        payload?: Record<string, unknown>;
      };
      if (row.kind !== BRAIN_LOG_EVENT_KIND.snapshot) continue;
      if (row.payload?.["reason"] !== BRAIN_SNAPSHOT_REASON.storeMigration) continue;
      const runId = typeof row.payload["run_id"] === "string" ? row.payload["run_id"] : "";
      const at = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
      return { device: shardId, runId, at: Number.isFinite(at) ? at : null };
    } catch {
      // a torn or foreign line: not the event
    }
  }
  return null;
}
