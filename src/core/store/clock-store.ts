/**
 * The local hybrid logical clock of one device, persisted in the
 * device-local state directory so it survives restarts (design D3).
 *
 * Without persistence a process that starts while the wall clock is behind
 * the last stamp it issued (a clock step, a suspended VM) would issue
 * stamps that order before its own earlier records. Every tick is a read,
 * a rule from `hlc.ts` and an atomic write, under a device-local lock so
 * concurrent processes on one device never issue the same stamp; an
 * observation is the same, with the write only when the observed stamp
 * raises the saved clock.
 *
 * The file is `<device-state-dir>/clock/<device>.json`, holding
 * `{ "hlc": "<physical_ms>.<counter>" }`. A missing file, or one whose
 * content does not parse, starts from zero: the send rule still takes the
 * wall clock, so the only loss is protection against a backwards wall
 * clock across that one restart. A file that exists but cannot be read
 * right now (EBUSY, EPERM, EACCES from an antivirus or indexer handle on
 * Windows) is an error instead: the write fails rather than the saved
 * clock, and the remote stamps it absorbed, being reset.
 *
 * Reading is receiving. Every shard read raises an in-process floor for
 * its store (`clock-floor.ts`, called by `reader.ts`), and the next tick
 * for that store takes the receive rule over the floor first.
 * So a write that replaces, removes or raises a record it (or anything
 * before it in the process) read orders after that record in every fold,
 * even when the record's device stamped it ahead of this machine's wall
 * clock. A stamp more than `HLC_MAX_DRIFT_MS` ahead is still ignored by
 * the receive rule.
 */

import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { renameWithRetry } from "../fs-atomic.ts";
import { STORE_CLOCK_DIR } from "./constants.ts";
import {
  compareHlc,
  formatHlc,
  HLC_ZERO,
  parseHlc,
  receiveHlc,
  receiveRaises,
  sendHlc,
  type Hlc,
} from "./hlc.ts";
import { withLocalLock } from "./local-lock.ts";

/** Wall clock in milliseconds; injectable so tests can move time. */
export type WallClock = () => number;

const systemWallClock: WallClock = () => Date.now();

/** Path of the persisted clock of `device` under a device-local state directory. */
export function clockFilePath(deviceStateDir: string, device: string): string {
  return join(deviceStateDir, STORE_CLOCK_DIR, `${device}.json`);
}

/**
 * The persisted clock of `device`, or `null` when none was stored or its
 * content does not parse. Any read error but a missing file propagates.
 */
export function readClock(deviceStateDir: string, device: string): Hlc | null {
  let text: string;
  try {
    text = readFileSync(clockFilePath(deviceStateDir, device), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as { hlc?: unknown };
    return typeof parsed.hlc === "string" ? parseHlc(parsed.hlc) : null;
  } catch {
    return null;
  }
}

/**
 * Replace the clock file with `text`: a temporary file, written and
 * flushed to disk, then renamed over the clock file. Runs under the clock
 * lock. The flush comes before the rename, so every file that is ever
 * renamed to the clock's name is already on disk: a directory entry made
 * durable later, by any process, points at a flushed file and never at an
 * empty or half-written one, which `readClock` would read as no clock at
 * all and the next tick would restart from zero.
 */
function replaceClock(path: string, text: string): void {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // the write's or the rename's error is the answer
    }
    throw err;
  }
}

/**
 * Make the clock file's directory entry durable: the directory flush,
 * after the clock lock is released and before the update's value is
 * handed out. Ordering: the entry the update read or wrote was renamed
 * into place, a flushed file, before the release, and every rename after
 * it, by any process, is of a flushed file with a clock not behind it
 * (the clock only moves forward under the lock). The flush makes the
 * entry the directory holds now durable, so when it returns the durable
 * clock is not behind the value the update read or wrote, and no record
 * carrying a stamp from it is written before it returns: a crash can no
 * longer make a later tick reissue it or a lower one. On Windows there
 * is no directory flush; the rename is atomic there. Returns whether the
 * entry is durable (false when the flush failed).
 */
function persistClockEntry(path: string): boolean {
  if (process.platform === "win32") return true;
  try {
    const dfd = openSync(dirname(path), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
    return true;
  } catch {
    // Best effort, as in `atomicWriteText`.
    return false;
  }
}

/**
 * The newest clock of each clock file whose directory entry this process
 * made durable ({@link persistClockEntry} after reading or writing that
 * clock). The clock only moves forward, so an entry read later that is
 * not ahead of it is durable already, and an observation that keeps
 * reading the same clock (a dream session's server) pays the directory
 * flush once, not on every read.
 */
const durableClocks = new Map<string, Hlc>();

/**
 * One clock step under the clock lock. The lock covers the read, the
 * rule, the write of the new file and its flush and rename; only the
 * directory flush runs after the release ({@link persistClockEntry}).
 * Every store append and every raising read on the device takes this
 * lock, so it is the most contended lock of a busy machine.
 *
 * The flush runs for the entry the step leaves, written or only read:
 * an observation that raises nothing may read an entry another process
 * renamed into place and has not flushed yet, and its value must not
 * be handed out (nor the observed stamp taken as covered) before that
 * entry is durable. It is skipped only for an entry this process has
 * already made durable ({@link durableClocks}).
 */
function update(
  deviceStateDir: string,
  device: string,
  step: (local: Hlc) => Hlc,
  keep: (local: Hlc) => boolean = () => true,
): Hlc {
  const path = clockFilePath(deviceStateDir, device);
  let entry: Hlc = HLC_ZERO;
  const next = withLocalLock(path, () => {
    const local = readClock(deviceStateDir, device) ?? HLC_ZERO;
    const out = step(local);
    entry = local;
    if (keep(local)) {
      replaceClock(path, `${JSON.stringify({ hlc: formatHlc(out) })}\n`);
      entry = out;
    }
    return out;
  });
  const durable = durableClocks.get(path);
  if (durable === undefined || compareHlc(entry, durable) > 0) {
    if (persistClockEntry(path)) durableClocks.set(path, entry);
  }
  return next;
}

/**
 * Send rule, persisted: the stamp for one new local record. With a
 * `floor` (the newest stamp read from the store, `clock-floor.ts`)
 * the receive rule takes it in first, so the stamp orders after it.
 */
export function tickClock(
  deviceStateDir: string,
  device: string,
  now: WallClock = systemWallClock,
  floor: Hlc | null = null,
): Hlc {
  return update(deviceStateDir, device, (local) => {
    const wall = now();
    return sendHlc(floor === null ? local : receiveHlc(local, floor, wall), wall);
  });
}

/**
 * {@link tickClock} for `count` new local records at once: the stamps of
 * consecutive sends, in order, under one lock and with one persisted
 * write (the last stamp), so a batch append pays one clock write instead
 * of one per record. The persisted clock is never behind a stamp handed
 * out, as with one tick per record.
 */
export function tickClockMany(
  deviceStateDir: string,
  device: string,
  count: number,
  now: WallClock = systemWallClock,
  floor: Hlc | null = null,
): Hlc[] {
  const out: Hlc[] = [];
  if (count <= 0) return out;
  update(deviceStateDir, device, (local) => {
    const wall = now();
    let at = floor === null ? local : receiveHlc(local, floor, wall);
    for (let i = 0; i < count; i += 1) {
      at = sendHlc(at, wall);
      out.push(at);
    }
    return at;
  });
  return out;
}

/**
 * Receive rule, persisted: raise the local clock after ingesting `remote`.
 * The file is written only when `remote` raises the saved clock
 * (`receiveRaises`): a stamp at or behind it is already ordered before
 * every later tick, and a reader that observes the same newest record on
 * every read (a dream session's server) then pays a lock and a read, not
 * an atomic write, per read.
 */
export function observeClock(
  deviceStateDir: string,
  device: string,
  remote: Hlc,
  now: WallClock = systemWallClock,
): Hlc {
  let wall = 0;
  return update(
    deviceStateDir,
    device,
    (local) => {
      wall = now();
      return receiveHlc(local, remote, wall);
    },
    (local) => receiveRaises(local, remote, wall),
  );
}
