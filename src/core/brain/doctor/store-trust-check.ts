/**
 * Doctor findings about what a synced peer can deliver into the brain
 * store, part of the store section (`store-check.ts`):
 *
 *  - a record id found in both partitions. Records never move between
 *    partitions, so one of the copies was put there by a peer or a broken
 *    writer; the search index keeps the first copy it read and refuses the
 *    other (`search/brain-store/ingest.ts`);
 *  - a store directory or file whose permissions let other local accounts
 *    read it (POSIX only). The store creates directories `0700` and files
 *    `0600`; a looser mode comes from an older build, a restore, or a sync
 *    tool that applied its own permissions. The format document is left
 *    out: it is readable on purpose and holds no record;
 *  - on Windows, a device directory named like a Windows device (`nul`,
 *    `con`, ...). A POSIX peer may hold such an id; on Windows the name
 *    is a device, so the shard listings skip that directory and its
 *    records are not read on this machine.
 *
 * Read-only: it never changes a mode or a file.
 */

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isValidDeviceId, isWindowsReservedDeviceId } from "../../config.ts";
import {
  LEDGER_STREAM,
  STORE_FORMAT_FILE,
  STORE_PARTITIONS,
  STORE_STREAMS,
  type StorePartition,
} from "../../store/constants.ts";
import type { PartitionShard } from "../../store/state-digest.ts";
import type { StoreInspection } from "../../store/store-open.ts";
import { partitionDir } from "../../store/store-paths.ts";
import type { DoctorIssue } from "../types.ts";

/** One record id was found in both partitions. */
export const STORE_RECORD_ID_CROSS_PARTITION_CODE = "store-record-id-cross-partition";
/** A store directory or file grants other local accounts access. */
export const STORE_MODE_LOOSE_CODE = "store-mode-loose";

/** On Windows, a device directory whose name Windows reserves for a device. */
export const STORE_DEVICE_DIR_RESERVED_CODE = "store-device-dir-reserved";

/** Ids or paths named in one finding before the rest are only counted. */
const SAMPLE = 5;

/** Permission bits the store never grants to the group or to others. */
const GROUP_OTHER_BITS = 0o077;

function sampled(items: ReadonlyArray<string>): string {
  const more = items.length > SAMPLE ? ` and ${items.length - SAMPLE} more` : "";
  return `${items.slice(0, SAMPLE).join(", ")}${more}`;
}

/** Record ids present in more than one partition this machine read. */
export function crossPartitionIdIssues(
  store: StoreInspection,
  shards: ReadonlyMap<StorePartition, ReadonlyArray<PartitionShard>>,
): DoctorIssue[] {
  const seen = new Map<string, StorePartition>();
  const twice: string[] = [];
  for (const partition of STORE_PARTITIONS) {
    const own = new Set<string>();
    for (const shard of shards.get(partition) ?? []) {
      for (const record of shard.all) own.add(record.id);
    }
    for (const id of own) {
      const first = seen.get(id);
      if (first === undefined) seen.set(id, partition);
      else if (first !== partition) twice.push(id);
    }
  }
  if (twice.length === 0) return [];
  return [
    {
      severity: "warning",
      code: STORE_RECORD_ID_CROSS_PARTITION_CODE,
      path: store.root,
      message:
        `${twice.length} record id(s) are in both the shared and the private partition: ` +
        `${sampled(twice)}. Records never move between partitions, so one copy was written by ` +
        "a peer or a broken writer; search keeps the first copy it read and ignores the other. " +
        "Find the shard that should not hold the id and remove that line",
    },
  ];
}

/** `value` single-quoted for a POSIX shell, an inner quote closed, escaped and reopened. */
function singleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Paths under `dir` (itself included) whose mode grants group or other access. */
function loosePaths(dir: string, out: string[]): void {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if ((stat.mode & GROUP_OTHER_BITS) !== 0) out.push(dir);
  if (!stat.isDirectory()) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    // The format document describes the format and holds no record; it is
    // written readable on purpose, inside a folder only the owner enters.
    if (name !== STORE_FORMAT_FILE) loosePaths(join(dir, name), out);
  }
}

/**
 * Held partitions whose directories or files grant other local accounts
 * access. Windows has no POSIX modes to check, so nothing is reported there.
 */
export function looseModeIssues(
  store: StoreInspection,
  platform: string = process.platform,
): DoctorIssue[] {
  if (platform === "win32") return [];
  const issues: DoctorIssue[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    const dir = partitionDir(store.root, partition);
    const loose: string[] = [];
    loosePaths(dir, loose);
    if (loose.length === 0) continue;
    issues.push({
      severity: "warning",
      code: STORE_MODE_LOOSE_CODE,
      path: dir,
      message:
        `${loose.length} path(s) in the ${partition} partition grant other accounts on this ` +
        `machine access (group or other permission bits): ${sampled(loose)}. The store keeps ` +
        `its directories at 0700 and its files at 0600; run ` +
        `\`chmod -R go-rwx ${singleQuoted(dir)}\` to restore that`,
    });
  }
  return issues;
}

function dirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * On Windows, device directories of held partitions named like a Windows
 * device (`nul`, `con`, ...): the shard listings skip them, so their
 * records are not read here. Elsewhere nothing is reported, because such a
 * name is read like any other device id.
 */
export function reservedDeviceDirIssues(
  store: StoreInspection,
  platform: string = process.platform,
): DoctorIssue[] {
  if (platform !== "win32") return [];
  const issues: DoctorIssue[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    const root = partitionDir(store.root, partition);
    const reserved: string[] = [];
    for (const stream of STORE_STREAMS) {
      const streamDirs =
        stream === LEDGER_STREAM
          ? dirNames(join(root, stream)).map((ledger) => join(root, stream, ledger))
          : [join(root, stream)];
      for (const dir of streamDirs) {
        for (const name of dirNames(dir)) {
          if (isValidDeviceId(name) && isWindowsReservedDeviceId(name))
            reserved.push(join(dir, name));
        }
      }
    }
    if (reserved.length === 0) continue;
    issues.push({
      severity: "warning",
      code: STORE_DEVICE_DIR_RESERVED_CODE,
      path: root,
      message:
        `${reserved.length} device folder(s) in the ${partition} partition carry a name Windows ` +
        `reserves for a device: ${sampled(reserved)}. Windows cannot read them, so the records in ` +
        "them are left out on this machine. Give the device that wrote them another device_id " +
        "in its machine config",
    });
  }
  return issues;
}
