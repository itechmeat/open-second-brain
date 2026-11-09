/**
 * The local hybrid logical clock of one device, persisted in the
 * device-local state directory so it survives restarts (design D3).
 *
 * Without persistence a process that starts while the wall clock is behind
 * the last stamp it issued (a clock step, a suspended VM) would issue
 * stamps that order before its own earlier records. Every tick and every
 * observation is a read, a rule from `hlc.ts` and an atomic write, under a
 * device-local lock so concurrent processes on one device never issue the
 * same stamp.
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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteText } from "../fs-atomic.ts";
import { STORE_CLOCK_DIR } from "./constants.ts";
import { formatHlc, HLC_ZERO, parseHlc, receiveHlc, sendHlc, type Hlc } from "./hlc.ts";
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

function update(deviceStateDir: string, device: string, step: (local: Hlc) => Hlc): Hlc {
  const path = clockFilePath(deviceStateDir, device);
  return withLocalLock(path, () => {
    const next = step(readClock(deviceStateDir, device) ?? HLC_ZERO);
    atomicWriteText(path, `${JSON.stringify({ hlc: formatHlc(next) })}\n`);
    return next;
  });
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

/** Receive rule, persisted: raise the local clock after ingesting `remote`. */
export function observeClock(
  deviceStateDir: string,
  device: string,
  remote: Hlc,
  now: WallClock = systemWallClock,
): Hlc {
  return update(deviceStateDir, device, (local) => receiveHlc(local, remote, now()));
}
