/**
 * One answer to "is this file still the bytes I parsed?" for a cache that
 * keys a small file's parsed content by its `stat`, without opening it.
 *
 * A stamp of (device, inode, size, mtime, ctime) is not proof on its own.
 * A file rewritten in place at the same size inside one tick of the
 * volume's clock keeps all five: Windows sets file times from the system
 * time, which advances per timer tick (about 1 to 15.6 ms), FAT keeps
 * mtime to 2 s, and a fast volume fits a parse, a rewrite and the next
 * check inside one tick. `git` calls this a racily clean file and answers
 * it the same way this module does: a stamp vouches for the bytes only
 * once the file's times are at least {@link RACY_WINDOW_MS} older than the
 * moment the bytes were read. Until then every check re-reads the file,
 * which for the small markers kept this way costs one open and a read for
 * a couple of seconds after the file changed, then nothing.
 *
 * Why that is enough: a write that lands after the read carries times of
 * at least the read time minus one tick (2 s on FAT), so a settled stamp,
 * whose times are older than that, cannot match it. Setting mtime back by
 * hand (`utimes`, a copy that preserves times) moves ctime, which the
 * stamp also compares, and the settled test looks at the later of the
 * two. What it cannot see is a volume whose clock runs more than the
 * window behind this process's clock (a network share with a skewed
 * server) combined with a same-size in-place rewrite; a volume whose clock
 * runs ahead only makes stamps settle later.
 */

import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";

import { sameDevIno } from "./fs-identity.ts";

/** File times this close to the read (or later) do not vouch for the bytes. */
export const RACY_WINDOW_MS = 2_000;

/** What a cache keeps about the file whose bytes it parsed. */
export interface FileStamp {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  /**
   * Wall-clock time (ms) of the observation, captured BEFORE the `stat`
   * and the read of the bytes: a later time (the moment the parse was
   * stored, a row was written) could be more than the racy window after
   * a write it never saw, and would vouch for bytes it does not hold.
   */
  readonly readAtMs: number;
}

/**
 * The stamp of a file whose `stat` was taken before its bytes were read.
 * `readAtMs` is the clock captured before that `stat` (never a default:
 * the caller is the one who knows when it looked).
 */
export function stampOfStats(stat: BigIntStats, readAtMs: number): FileStamp {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    readAtMs,
  };
}

/**
 * Whether a file whose `bigint` stat is `stat` had settled when it was
 * observed: its later time at least the racy window before `readAtMs`,
 * the clock captured before the `stat` and the read.
 */
export function statSettled(
  stat: { readonly mtimeNs: bigint; readonly ctimeNs: bigint },
  readAtMs: number,
): boolean {
  const latestNs = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
  return Number(latestNs / 1_000_000n) <= readAtMs - RACY_WINDOW_MS;
}

/**
 * Whether `stamp` proves that the file `now` describes still holds the
 * bytes parsed when the stamp was taken: every field equal, and the
 * file's later time at least {@link RACY_WINDOW_MS} before the read.
 */
export function stampVouches(stamp: FileStamp, now: BigIntStats): boolean {
  return (
    sameDevIno(stamp, now) &&
    stamp.size === now.size &&
    stamp.mtimeNs === now.mtimeNs &&
    stamp.ctimeNs === now.ctimeNs &&
    statSettled(stamp, stamp.readAtMs)
  );
}

/**
 * Whether a file whose times are `mtimeMs` and `ctimeMs` (a plain
 * `stat`) is settled at `readAtMs`: the later of the two at least
 * {@link RACY_WINDOW_MS} before it, `readAtMs` being the clock captured
 * before the `stat` and the read. For a cache that keeps its own record
 * of a file's stat and has to decide whether to keep it at all.
 */
export function timesSettled(mtimeMs: number, ctimeMs: number, readAtMs: number): boolean {
  return Math.max(mtimeMs, ctimeMs) <= readAtMs - RACY_WINDOW_MS;
}

/**
 * The stamp as a string, for a cache that keeps a key beside what it
 * parsed and compares keys, in memory or on disk. Take it before reading
 * the bytes, with `readAtMs` the clock captured before the `stat`. While the stamp has not settled the key is unique to this
 * call (a random suffix, so not even another process, or this one after
 * a restart, takes it again), so it equals no key taken before or after
 * it and the cache reads the file again: the same rule as
 * {@link stampVouches}, in the shape of a key.
 */
export function stampKey(stat: BigIntStats, readAtMs: number): string {
  const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (statSettled(stat, readAtMs)) return key;
  return `${key}:racy-${randomUUID()}`;
}
