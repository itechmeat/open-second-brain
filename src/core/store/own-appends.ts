/**
 * What this process appended to each shard, for the readers that keep
 * what they read (`read/stream-read.ts` tails). The module holds only the
 * appends, with no file or lock import, so the readers that load it stay
 * light, as `clock-floor.ts` does.
 */

import { resolve } from "node:path";

/** A file's stamp: what an append saw before and left after. */
export interface AppendStamp {
  readonly size: number;
  /** Modification and change times in nanoseconds, from `bigint` stats. */
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** One append under the shard's lock: the file before it and after it. */
interface OwnAppend {
  readonly before: AppendStamp;
  readonly after: AppendStamp;
}

/**
 * The latest appends of this process to each shard, by resolved path. A
 * reader that kept a shard at one stamp and finds it at another may skip
 * re-hashing the bytes it kept only when a chain of this process's
 * appends leads from the first stamp to the second, each starting from
 * exactly the stamp the one before it left: then no other writer appended
 * in between (an append by another writer moves the size), and a shard is
 * append-only. The times do not prove that nothing rewrote the file in
 * place: a write that lands in the clock tick of the stamp it follows
 * (Windows sets file times per timer tick, FAT keeps the mtime to 2 s)
 * leaves the stamp as it was. The format never rewrites a shard in place
 * (`FORMAT.md`, "Reading"), so the chain relies on that, not on the times.
 */
const ownAppends = new Map<string, OwnAppend[]>();

/** Appends kept per shard; a chain through an older one is not found, so a reader then hashes. */
const OWN_APPENDS_MAX = 64;

function same(a: AppendStamp, b: AppendStamp): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Note one append of this process: the file's stamp before it and after it. */
export function noteOwnAppend(path: string, before: AppendStamp, after: AppendStamp): void {
  const key = resolve(path);
  const list = ownAppends.get(key) ?? [];
  list.push({ before, after });
  if (list.length > OWN_APPENDS_MAX) list.shift();
  ownAppends.set(key, list);
}

/**
 * Whether appends of this process alone took `path` from stamp `from` to
 * stamp `to`; `from` null: from an empty file (a shard this process
 * created).
 */
export function appendedByThisProcess(
  path: string,
  from: AppendStamp | null,
  to: AppendStamp,
): boolean {
  const list = ownAppends.get(resolve(path));
  if (list === undefined) return false;
  let at = list.findIndex((a) => (from === null ? a.before.size === 0 : same(a.before, from)));
  if (at === -1) return false;
  for (; at < list.length; at++) {
    const append = list[at]!;
    if (same(append.after, to)) return true;
    const next = list[at + 1];
    if (next === undefined || !same(next.before, append.after)) return false;
  }
  return false;
}
