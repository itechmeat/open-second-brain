/**
 * The metadata pass of catch-up (design D5): every shard of every held
 * partition, with one `stat` per shard and no file opened.
 *
 * Directory listings are cached by directory mtime: a directory whose
 * mtime has not moved since it was listed is not listed again, so an
 * unchanged store costs one `stat` per directory and per shard. A listing
 * taken within {@link RACY_LISTING_MS} of the directory's mtime is not
 * trusted (an entry added in the same mtime tick would be invisible to
 * the comparison), the same rule `git` applies to racily clean files.
 *
 * File identity is `dev:ino` from a bigint stat (on Windows, Node reports
 * the volume serial number and the 64-bit file index there). A filesystem
 * that reports no inode falls back to the birth time, and failing that to
 * an empty identity: the verified-prefix hash then has to catch a
 * replacement on its own.
 */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import {
  LEDGER_STREAM,
  STORE_STREAMS,
  type StorePartition,
  type StoreStream,
} from "../../store/constants.ts";
import { isReadableDeviceDir, isShardFileName } from "../../store/shard-list.ts";
import { LEDGER_NAME_RE, partitionDir } from "../../store/store-paths.ts";
import type { IndexedStore } from "./location.ts";

/** A listing taken this close to its directory's mtime is re-taken next time. */
export const RACY_LISTING_MS = 2000;

/** One shard as the metadata pass sees it. */
export interface ShardStat {
  /** `<partition>/<rel>`: the watermark key. */
  readonly key: string;
  readonly partition: StorePartition;
  readonly stream: StoreStream;
  readonly ledger: string | null;
  readonly device: string;
  /** Partition-relative path, `/`-separated. */
  readonly rel: string;
  readonly path: string;
  readonly identity: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface Entry {
  readonly name: string;
  readonly dir: boolean;
  readonly file: boolean;
}

interface CachedListing {
  readonly mtimeMs: number;
  readonly listedAt: number;
  readonly entries: ReadonlyArray<Entry>;
}

/** The identity, size and mtime of a file, or `null` when it is gone. */
export function statShardFile(
  path: string,
): Pick<ShardStat, "identity" | "size" | "mtimeMs"> | null {
  const st = statSync(path, { bigint: true, throwIfNoEntry: false });
  if (st === undefined || !st.isFile()) return null;
  let identity = "";
  if (st.ino !== 0n) identity = `${st.dev}:${st.ino}`;
  else if (st.birthtimeNs !== 0n) identity = `birth:${st.birthtimeNs}`;
  return { identity, size: Number(st.size), mtimeMs: Number(st.mtimeNs / 1_000_000n) };
}

/** A per-process scanner of one store, holding the directory listing cache. */
export class ShardScanner {
  private readonly listings = new Map<string, CachedListing>();

  constructor(private readonly store: IndexedStore) {}

  /** Every shard of the held partitions, sorted by key. */
  scan(): ShardStat[] {
    const out: ShardStat[] = [];
    for (const partition of this.store.partitions) {
      const root = partitionDir(this.store.root, partition);
      for (const stream of STORE_STREAMS) {
        const streamDir = join(root, stream);
        if (stream === LEDGER_STREAM) {
          for (const ledger of this.list(streamDir)) {
            if (!ledger.dir || !LEDGER_NAME_RE.test(ledger.name)) continue;
            this.scanDevices(out, partition, stream, ledger.name, join(streamDir, ledger.name));
          }
        } else {
          this.scanDevices(out, partition, stream, null, streamDir);
        }
      }
    }
    return out.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  private scanDevices(
    out: ShardStat[],
    partition: StorePartition,
    stream: StoreStream,
    ledger: string | null,
    dir: string,
  ): void {
    for (const device of this.list(dir)) {
      if (!device.dir || !isReadableDeviceDir(device.name)) continue;
      const deviceDir = join(dir, device.name);
      for (const file of this.list(deviceDir)) {
        if (!file.file || !isShardFileName(file.name)) continue;
        const path = join(deviceDir, file.name);
        const st = statShardFile(path);
        if (st === null) continue; // removed between the listing and the stat
        const segments = ledger === null ? [stream] : [stream, ledger];
        const rel = posix.join(...segments, device.name, file.name);
        out.push({
          key: `${partition}/${rel}`,
          partition,
          stream,
          ledger,
          device: device.name,
          rel,
          path,
          ...st,
        });
      }
    }
  }

  /**
   * The entries of `dir`, from the cache when its mtime has not moved.
   * Every directory listed here is below a partition folder, and `lstat`
   * reads one that is a symbolic link or a junction as no directory: a
   * linked stream, ledger or device folder a peer synced could otherwise
   * index another partition's records under this one.
   */
  private list(dir: string): ReadonlyArray<Entry> {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st === undefined || !st.isDirectory()) {
      this.listings.delete(dir);
      return [];
    }
    const cached = this.listings.get(dir);
    if (
      cached !== undefined &&
      cached.mtimeMs === st.mtimeMs &&
      cached.listedAt - st.mtimeMs > RACY_LISTING_MS
    ) {
      return cached.entries;
    }
    const listedAt = Date.now();
    let entries: Entry[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((d) => ({
        name: d.name,
        dir: d.isDirectory(),
        file: d.isFile(),
      }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    this.listings.set(dir, { mtimeMs: st.mtimeMs, listedAt, entries });
    return entries;
  }
}
