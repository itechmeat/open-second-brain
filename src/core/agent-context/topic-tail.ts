/**
 * The neighbour lane's own read of the `topics` stream (owner check of
 * five concurrent agents): what was appended to each topics shard since
 * this session's last turn, read straight from the shards.
 *
 * The lane used to ask the search index, after a catch-up. A catch-up
 * writes the index, and under concurrent agents another process (a hook,
 * an MCP server, a reindex, a view render) usually held the index's
 * writer lock: the catch-up was skipped, the index answered without the
 * records just written, and the turn showed an empty block, the records
 * coming a turn late. Every turn also stat'ed every shard of every stream
 * and ingested what moved, a cost that grows with the store.
 *
 * Here a turn takes no lock and reads only the topics shards: one listing
 * and one `lstat` per shard, and for a shard that grew only the bytes
 * appended past the session's cursor (the byte offset of the end of the
 * last complete line read, keyed by the shard's partition-relative path
 * and its device and inode, and the clock stamp of the newest record
 * passed in it). A shard holds one device's records in the order that
 * device stamped them, so that stamp tells new records from old ones
 * whenever the bytes cannot:
 *
 *  - a file replaced under the name (how a file-sync tool delivers
 *    another machine's grown shard: a temp file holding the old lines and
 *    the new ones, renamed over it) is read whole, and only the records
 *    stamped after the cursor's are reported, each once; a rewrite that
 *    adds nothing (a compaction) reports nothing;
 *  - a shard the cursor does not know is read whole and reported whole (a
 *    new device, a new month, a shard sync delivers late), except a
 *    compaction's output: a `compacted` record naming it in `into`
 *    limits it to what was stamped after the newest record the cursor
 *    passed in the shards it `replaces` (an output that has not arrived
 *    yet keeps that floor in the cursor until it does);
 *  - a shard that shrank under the same file moves to its end unreported.
 *
 * The cursor stays one entry per shard the session has seen (entries of
 * shards no longer listed stay for the session, which ends after a day). A last line still being written is
 * left for the next turn. The first turn of a session reads nothing: it places the cursor
 * at the end of every shard.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs";

import type { StorePartition } from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { compareCodeUnits } from "../store/compare.ts";
import { compareHlc, parseHlc } from "../store/hlc.ts";
import { readShard, type Compaction } from "../store/reader.ts";
import { listShards } from "../store/shard-list.ts";
import { partitionDir } from "../store/store-paths.ts";
import { TOPIC_STREAM } from "../topics/constants.ts";

/** Where the session's last turn stopped reading one shard. */
export interface TopicCursorEntry {
  /** `<dev>:<ino>` of the shard file. */
  readonly id: string;
  /** End of the last complete line read: where the next read starts. */
  readonly offset: number;
  /**
   * The clock stamp of the newest record the session has passed in this
   * shard. A shard holds one device's records in the order that device
   * stamped them, so a record stamped later is one the session has not
   * seen: this is what tells new records from old ones when the file is
   * replaced. Absent when the shard held no readable record.
   */
  readonly hlc?: string;
}

/** The session's cursor: one entry per shard, by `<partition>/<shard path>`. */
export type TopicCursor = Readonly<Record<string, TopicCursorEntry>>;

export interface TopicTailRecord {
  readonly record: StoreRecord;
  readonly partition: StorePartition;
}

export interface TopicTail {
  /** No cursor was given: the cursor is placed at the end, nothing is read. */
  readonly reseed: boolean;
  /** The records appended since the cursor, newest first. */
  readonly records: ReadonlyArray<TopicTailRecord>;
  /** The cursor after this read. */
  readonly cursor: TopicCursor;
}

/** Bytes scanned backwards at a time for the end of the last complete line. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/** The offset just past the last newline of the first `size` bytes of `path` (0 without one). */
function endOfCompleteLines(path: string, size: number): number {
  if (size === 0) return 0;
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(Math.min(TAIL_CHUNK_BYTES, size));
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const got = readSync(fd, chunk, 0, end - start, start);
      for (let i = got - 1; i >= 0; i--) if (chunk[i] === 0x0a) return start + i + 1;
      end = start;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

/** The clock stamp of the last complete line before `end`, or undefined. */
function lastLineHlc(path: string, end: number): string | undefined {
  if (end === 0) return undefined;
  const start = endOfCompleteLines(path, end - 1);
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(end - start);
    readSync(fd, bytes, 0, bytes.length, start);
    const value = (JSON.parse(bytes.toString("utf8")) as { hlc?: unknown }).hlc;
    return typeof value === "string" && parseHlc(value) !== null ? value : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The later of two clock stamps (either may be absent). */
function laterHlc(a: string | undefined, b: string | undefined): string | undefined {
  const pa = a === undefined ? null : parseHlc(a);
  const pb = b === undefined ? null : parseHlc(b);
  if (pa === null) return pb === null ? undefined : b;
  if (pb === null) return a;
  return compareHlc(pa, pb) >= 0 ? a : b;
}

/** Whether `hlc` is stamped after `floor` (always, without a floor). */
function after(hlc: string, floor: string | undefined): boolean {
  if (floor === undefined) return true;
  const p = parseHlc(hlc);
  const f = parseHlc(floor);
  return p === null || f === null || compareHlc(p, f) > 0;
}

function newestFirst(a: TopicTailRecord, b: TopicTailRecord): number {
  const ha = parseHlc(a.record.hlc);
  const hb = parseHlc(b.record.hlc);
  const byClock = ha !== null && hb !== null ? compareHlc(hb, ha) : 0;
  return byClock !== 0 ? byClock : compareCodeUnits(b.record.id, a.record.id);
}

/**
 * Read the topics stream of `partitions` in the store at `root` past
 * `cursor` (see the module comment); `undefined` places a new cursor.
 * Never takes a lock and never writes. A shard that cannot be read keeps
 * its old cursor entry, so what it holds is read next turn.
 */
export function readTopicTail(
  root: string,
  partitions: ReadonlyArray<StorePartition>,
  cursor: TopicCursor | undefined,
): TopicTail {
  const next: Record<string, TopicCursorEntry> = {};
  const found: TopicTailRecord[] = [];
  for (const partition of partitions) {
    const partitionRoot = partitionDir(root, partition);
    const listed = new Set<string>();
    // Shards the cursor has not seen are reported after every shard is
    // read, once the compactions this turn read are known.
    const unseen: Array<{ readonly key: string; readonly records: TopicTailRecord[] }> = [];
    const compactions: Compaction[] = [];
    for (const shard of listShards(partitionRoot, { stream: TOPIC_STREAM })) {
      const key = `${partition}/${shard.rel}`;
      listed.add(key);
      const before = cursor?.[key];
      try {
        const stat = lstatSync(shard.path, { bigint: true });
        if (!stat.isFile()) continue;
        const id = `${stat.dev}:${stat.ino}`;
        const size = Number(stat.size);
        if (
          cursor === undefined ||
          (before !== undefined && before.id === id && size < before.offset)
        ) {
          // A new cursor, or a shard that shrank: start at its end, report
          // nothing.
          const end = endOfCompleteLines(shard.path, size);
          const hlc = laterHlc(before?.hlc, lastLineHlc(shard.path, end));
          next[key] = { id, offset: end, ...(hlc !== undefined ? { hlc } : {}) };
          continue;
        }
        // The same file grown: read from the old offset. A file replaced
        // under the name (a sync tool writes a temp file and renames it
        // over the shard, old lines and new ones): read it whole and keep
        // what was stamped after the newest record the session passed
        // there. A shard the cursor does not know: read it whole.
        const sameFile = before !== undefined && before.id === id;
        const offset = sameFile ? before.offset : 0;
        if (sameFile && size === offset) {
          next[key] = before;
          continue;
        }
        const read = readShard(shard.path, { offset, partitionRoot });
        compactions.push(...read.compactions);
        const floor = sameFile ? undefined : before?.hlc;
        const kept: TopicTailRecord[] = [];
        let hlc = before?.hlc;
        for (const r of read.records) {
          hlc = laterHlc(hlc, r.record.hlc);
          if (r.quarantined === true || !after(r.record.hlc, floor)) continue;
          kept.push({ record: r.record, partition });
        }
        if (before === undefined) unseen.push({ key, records: kept });
        else found.push(...kept);
        next[key] = { id, offset: read.nextOffset, ...(hlc !== undefined ? { hlc } : {}) };
      } catch {
        if (before !== undefined) next[key] = before;
      }
    }
    // A compaction writes a device's records again under a new name and
    // removes the old shards: the new shard holds what the session passed
    // in the shards it replaces, so only what was stamped after their
    // newest record is new there. Every other shard the cursor has not
    // seen is reported whole: a new device, a new month, or a shard sync
    // delivered late, whatever its stamps.
    const intoFloor = new Map<string, string | undefined>();
    for (const c of compactions) {
      let floor: string | undefined;
      for (const rel of c.replaces) floor = laterHlc(floor, cursor?.[`${partition}/${rel}`]?.hlc);
      if (floor === undefined) continue;
      for (const rel of c.into) intoFloor.set(`${partition}/${rel}`, floor);
    }
    for (const { key, records } of unseen) {
      const floor = intoFloor.get(key);
      found.push(...records.filter(({ record }) => after(record.hlc, floor)));
    }
    if (cursor === undefined) continue;
    for (const [key, floor] of intoFloor) {
      // A compaction's output that has not arrived yet: an entry with no
      // file, so it is read as a replaced file when it comes.
      if (!listed.has(key) && next[key] === undefined && floor !== undefined) {
        next[key] = { id: "", offset: 0, hlc: floor };
      }
    }
    // Entries of shards no longer listed stay for the rest of the session:
    // a compaction that replaced them may still name them.
    for (const [key, entry] of Object.entries(cursor)) {
      if (key.startsWith(`${partition}/`) && !listed.has(key) && next[key] === undefined) {
        next[key] = entry;
      }
    }
  }
  if (cursor === undefined) return { reseed: true, records: [], cursor: next };
  // One record can be read from two shards in one turn (a compaction's
  // output beside the shard it replaces, before that one is removed): it
  // is reported once, before any cap counts it.
  const seen = new Set<string>();
  const unique: TopicTailRecord[] = [];
  for (const entry of found) {
    if (seen.has(entry.record.id)) continue;
    seen.add(entry.record.id);
    unique.push(entry);
  }
  return { reseed: false, records: unique.toSorted(newestFirst), cursor: next };
}
