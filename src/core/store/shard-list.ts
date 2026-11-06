/**
 * Enumerate the shards of one stream in a partition (design D1).
 *
 * A shard is `<stream>[/<ledger>]/<device>/<YYYY-MM>[.<suffix>].jsonl`,
 * where the optional suffix names a compaction output. Every other entry
 * (a sync tool's conflict copy, a temp file, a stray directory) is not a
 * shard and is left out, so a reader never folds a half-merged copy.
 */

import { readdirSync, type Dirent } from "node:fs";
import { join, posix } from "node:path";

import { isValidDeviceId, isWindowsReservedDeviceId } from "../config.ts";
import { compareCodeUnits } from "./compare.ts";
import { STORE_SHARD_EXT } from "./constants.ts";
import { LEDGER_NAME_RE, type StreamRef } from "./store-paths.ts";

/** Shard file names: a month, an optional compaction suffix, the extension. */
export const SHARD_FILE_RE = new RegExp(
  `^\\d{4}-(0[1-9]|1[0-2])(\\.[a-z0-9][a-z0-9-]{0,39})?\\.${STORE_SHARD_EXT}$`,
);

/** Whether `name` is a shard file name (and not a sync tool's conflict copy). */
export function isShardFileName(name: string): boolean {
  return SHARD_FILE_RE.test(name) && !name.includes(".sync-conflict");
}

/**
 * Whether a device directory named `name` is read on `platform`: a valid
 * device id, and on Windows not a reserved name (`nul`, `con`, ...),
 * which there names a device rather than a directory. Such a directory
 * cannot exist on NTFS; one that does is skipped and the doctor reports
 * it. Elsewhere a reserved name is read like any other id.
 */
export function isReadableDeviceDir(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isValidDeviceId(name) && !(platform === "win32" && isWindowsReservedDeviceId(name));
}

export interface ShardEntry {
  readonly device: string;
  /** Path relative to the partition, `/`-separated. */
  readonly rel: string;
  /** Absolute path. */
  readonly path: string;
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Every shard of `ref` in the partition at `partitionRoot`, sorted by
 * relative path. A shard name that is a symbolic link is listed too, as is
 * a shard under a stream or ledger folder that is a link: given the
 * partition, the reader refuses to read through either (`not-a-file`), and
 * listing them is what lets the doctor report them instead of passing over
 * them in silence. A device folder that is a link is no directory entry
 * here and is skipped.
 */
export function listShards(partitionRoot: string, ref: StreamRef): ShardEntry[] {
  const segments = ref.ledger === undefined ? [ref.stream] : [ref.stream, ref.ledger];
  if (ref.ledger !== undefined && !LEDGER_NAME_RE.test(ref.ledger)) return [];
  const streamDir = join(partitionRoot, ...segments);
  const out: ShardEntry[] = [];
  for (const deviceEntry of entries(streamDir)) {
    if (!deviceEntry.isDirectory() || !isReadableDeviceDir(deviceEntry.name)) continue;
    for (const file of entries(join(streamDir, deviceEntry.name))) {
      if (!(file.isFile() || file.isSymbolicLink()) || !isShardFileName(file.name)) continue;
      out.push({
        device: deviceEntry.name,
        rel: posix.join(...segments, deviceEntry.name, file.name),
        path: join(streamDir, deviceEntry.name, file.name),
      });
    }
  }
  return out.toSorted((a, b) => compareCodeUnits(a.rel, b.rel));
}
