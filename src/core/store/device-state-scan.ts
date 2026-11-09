/**
 * The entries of a store's device-local state directory that are keyed by
 * a device id other than this machine's (design D1, task 2.12).
 *
 * That directory belongs to one machine and is never synced (FORMAT.md,
 * "Device-local state"). Two of its families carry a device id in their
 * names, because a writer keys them by the device it writes as:
 *
 *  - the persisted clock, `clock/<device>.json`, with its lock folder
 *    `clock/<device>.json.lock` and any temp file of its atomic rewrite;
 *  - the shard append locks, `locks/<partition>/<stream>/<device>/...` and
 *    `locks/<partition>/ledgers/<name>/<device>/...`.
 *
 * Every other entry (the search index, blob temp files, the remembered
 * store root) is store-wide and never looked at. A name that is not a
 * valid device id is not device-keyed and is left out too.
 *
 * Read-only: it lists directories and never follows a link out of them.
 */

import { readdirSync, type Dirent } from "node:fs";
import { join, posix } from "node:path";

import { isValidDeviceId } from "../config.ts";
import { compareCodeUnits } from "./compare.ts";
import {
  LEDGER_STREAM,
  STORE_CLOCK_DIR,
  STORE_LOCKS_DIR,
  STORE_PARTITIONS,
  STORE_STREAMS,
} from "./constants.ts";

/** One foreign device and the entries that carry its id. */
export interface ForeignDeviceEntries {
  readonly device: string;
  /** Paths relative to the state directory, `/`-separated, sorted. */
  readonly entries: ReadonlyArray<string>;
}

/** The clock file of a device, and everything derived from its name (`.lock`, temp files). */
const CLOCK_ENTRY_RE = /^(.+?)\.json(?:\..*)?$/;

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // Missing, not a directory, or unreadable: nothing keyed to report.
    return [];
  }
}

/** Real subdirectories of `dir` (a link is never descended). */
function subdirs(dir: string): string[] {
  return list(dir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Entries of `stateDir` keyed by a device id other than `ownDevice`, one
 * item per foreign device, sorted by device id.
 */
export function foreignDeviceEntries(
  stateDir: string,
  ownDevice: string,
): ReadonlyArray<ForeignDeviceEntries> {
  const found = new Map<string, string[]>();
  const add = (device: string, rel: string): void => {
    if (device === ownDevice || !isValidDeviceId(device)) return;
    const own = found.get(device);
    if (own === undefined) found.set(device, [rel]);
    else own.push(rel);
  };

  for (const entry of list(join(stateDir, STORE_CLOCK_DIR))) {
    const match = CLOCK_ENTRY_RE.exec(entry.name);
    if (match !== null) add(match[1]!, posix.join(STORE_CLOCK_DIR, entry.name));
  }

  const locks = join(stateDir, STORE_LOCKS_DIR);
  for (const partition of subdirs(locks)) {
    if (!(STORE_PARTITIONS as ReadonlyArray<string>).includes(partition)) continue;
    for (const stream of subdirs(join(locks, partition))) {
      if (!(STORE_STREAMS as ReadonlyArray<string>).includes(stream)) continue;
      // A ledger's device folders sit one level deeper, under the ledger name.
      const parents =
        stream === LEDGER_STREAM
          ? subdirs(join(locks, partition, stream)).map((ledger) => [stream, ledger])
          : [[stream]];
      for (const segments of parents) {
        for (const device of list(join(locks, partition, ...segments))) {
          add(device.name, posix.join(STORE_LOCKS_DIR, partition, ...segments, device.name));
        }
      }
    }
  }

  return [...found]
    .toSorted(([a], [b]) => compareCodeUnits(a, b))
    .map(([device, entries]) => ({ device, entries: entries.toSorted(compareCodeUnits) }));
}
