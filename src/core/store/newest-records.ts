/**
 * Each device's newest record in the partitions this machine holds,
 * exactly as a fold of every record finds it, and the devices it cannot
 * tell for.
 *
 * The two questions the migration cohort asks (a device's last evidence
 * of life, and whether a retired device wrote again) need one record per
 * device: its greatest by {@link compareRecords}. The fold that answered
 * them verified every line of the store (parse, checksum, blob reference)
 * twice per doctor run, status block and removal; on a migrated store that
 * is seconds and the memory of the busiest shard.
 *
 * This read is exact without verifying every line. Every shard of every
 * stream is scanned for the envelope prefix of each line only
 * (`{"v":1,"id":"<ulid>","hlc":"<clock>","device":"<id>"`, the writer's
 * fixed key order); the line with the greatest clock is then read through
 * the shard reader, from its offset, and must come back as that same
 * verified record. Any doubt reads the shard whole through the reader, as
 * the fold does, and so equals the fold for that shard:
 *
 *  - a line without the canonical prefix (a corrupt or torn line, another
 *    format version, a key written another way), a line naming another
 *    device than its shard, a line holding a second `hlc` key or an escape
 *    sequence (JSON could read a key the prefix scan did not), a line past
 *    the line-size cap;
 *  - two lines with the greatest clock (one device never stamps twice);
 *  - a greatest line the reader does not hand back as that record (a bad
 *    checksum, a held-back last line, a quarantined line).
 *
 * No window and no bound on the order of appends is assumed: every line's
 * prefix is read, so a record appended out of clock order anywhere in a
 * shard is seen. Empty shards add nothing, as in the fold.
 *
 * What the fold itself cannot see, this read reports instead of hiding:
 * a device with a shard that cannot be read (an I/O or permission error,
 * a link or special file under a shard name), with a rejected line where
 * the prefix scan finds its greatest clock (a line the reader names as a
 * gap; a torn last line is not one, and a rejected line below a verified
 * greater clock cannot be the newest), or with a shard this machine saw
 * before that is gone, is in {@link NewestRecords.uncertain}: its newest record may be one nobody
 * could read. A caller that gates a destructive step treats such a device
 * as alive.
 */

import { closeSync, readdirSync, readSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { COMPACTED_KIND, STORE_LINE_CAP_BYTES, STORE_PARTITIONS } from "./constants.ts";
import { compareRecords, type StoreRecord } from "./envelope.ts";
import { gcHintTick } from "./gc-hint.ts";
import { compareHlc, parseHlc, type Hlc } from "./hlc.ts";
import { replacedShards, scanShard, shardScanGap, type Compaction } from "./reader.ts";
import { openRegularFileForRead } from "./safe-fs.ts";
import { trackSeenShards } from "./seen-shards.ts";
import { isReadableDeviceDir, isShardFileName, listShards, type ShardEntry } from "./shard-list.ts";
import { streamRefs } from "./state-digest.ts";
import type { StoreHandle } from "./store-open.ts";
import { partitionDir, type StreamRef } from "./store-paths.ts";

/** Each device's newest record, and the devices whose answer may be short. */
export interface NewestRecords {
  /** Each device's greatest record, equal to what a fold of every record finds. */
  readonly newest: ReadonlyMap<string, StoreRecord>;
  /**
   * Devices with a shard this machine could not read whole: the fold's
   * answer for them may miss their newest record. Never "silent".
   */
  readonly uncertain: ReadonlySet<string>;
}

/** The writer's envelope prefix: version, id, clock, device, in that order. */
const PREFIX_RE =
  /^\{"v":1,"id":"([0-9A-HJKMNP-TV-Z]{26})","hlc":"(\d+\.\d+)","device":"([a-z0-9-]{1,32})"/;
/** The quoted name `hlc`, and the escape a key could hide behind. */
const HLC_NAME = Buffer.from('"hlc"');
const ESCAPE = Buffer.from("\\u");
/** The compaction record kind, quoted, wherever it appears in a line. */
const COMPACTED_NAME = Buffer.from(`"${COMPACTED_KIND}"`);

/** Devices with an entry under a shard name that is no file and no link. */
function devicesWithSpecialShards(partitionRoot: string, ref: StreamRef): string[] {
  const segments = ref.ledger === undefined ? [ref.stream] : [ref.stream, ref.ledger];
  const streamDir = join(partitionRoot, ...segments);
  const out: string[] = [];
  for (const deviceEntry of entriesOf(streamDir)) {
    if (!deviceEntry.isDirectory() || !isReadableDeviceDir(deviceEntry.name)) continue;
    for (const file of entriesOf(join(streamDir, deviceEntry.name))) {
      if (!isShardFileName(file.name)) continue;
      if (file.isFile() || file.isSymbolicLink() || file.isDirectory()) continue;
      out.push(deviceEntry.name);
      break;
    }
  }
  return out;
}

/** A folder's entries; none when it is absent (`listShards` refuses the rest). */
function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** How many times a key `hlc` (any spacing before its colon) occurs in `line`. */
function hlcKeys(line: Buffer): number {
  let count = 0;
  for (let at = line.indexOf(HLC_NAME); at !== -1; at = line.indexOf(HLC_NAME, at + 1)) {
    let next = at + HLC_NAME.length;
    // JSON whitespace (RFC 8259): space, tab, carriage return, line feed.
    while (
      next < line.length &&
      (line[next] === 0x20 || line[next] === 0x09 || line[next] === 0x0d || line[next] === 0x0a)
    ) {
      next += 1;
    }
    if (line[next] === 0x3a) count += 1;
  }
  return count;
}
/** Bytes of each line the prefix is read from. */
const PREFIX_BYTES = 160;
/** Bytes read from a shard per call. */
const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/** Each device's newest record over the held partitions; see the module docblock. */
export function newestRecordOfEachDevice(
  store: Pick<StoreHandle, "root" | "partitions">,
): NewestRecords {
  const newest = new Map<string, StoreRecord>();
  const uncertain = new Set<string>();
  const keep = (record: StoreRecord): void => {
    const seen = newest.get(record.device);
    if (seen === undefined || compareRecords(record, seen) > 0) newest.set(record.device, record);
  };
  // One read buffer for every shard of the call: a chunk, behind the
  // unterminated rest of the one before (never longer than a line may be).
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES + STORE_LINE_CAP_BYTES);
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    const root = partitionDir(store.root, partition);
    const listed: string[] = [];
    const compactions: Compaction[] = [];
    for (const ref of streamRefs(root)) {
      // A special file (a FIFO, a socket, a device) under a shard name is
      // not listed as a shard, and nothing is read from it: its device may
      // have records there, so it reads as uncertain.
      for (const device of devicesWithSpecialShards(root, ref)) uncertain.add(device);
      for (const shard of listShards(root, ref)) {
        listed.push(shard.rel);
        const fast = greatestByPrefix(shard, root, buffer);
        if (fast !== null && fast !== "doubt") {
          if (fast !== "empty") keep(fast);
          continue;
        }
        readWhole(shard, root, keep, compactions, () => uncertain.add(shard.device));
      }
    }
    // A shard this machine saw before and the listing no longer finds (a
    // sync deleting it, a rename): its device's newest record may have
    // been in it. The listing is recorded as seen, as the fold records it,
    // and a shard a verified compaction record replaced is no gap, as in
    // the fold (a shard holding a compaction record is read whole).
    for (const rel of trackSeenShards(root, { prefix: "" }, listed, replacedShards(compactions))) {
      const parts = rel.split("/");
      const device = parts.at(-2);
      if (device !== undefined) uncertain.add(device);
    }
  }
  return { newest, uncertain };
}

/** The shard read whole through the reader, as the fold reads it. */
function readWhole(
  shard: ShardEntry,
  partitionRoot: string,
  keep: (record: StoreRecord) => void,
  compactions: Compaction[],
  cannotTell: () => void,
): void {
  try {
    const scan = scanShard(shard.path, { partitionRoot }, (read) => keep(read.record));
    compactions.push(...scan.compactions);
    if (scan.diagnostics.some((d) => d.kind === "not-a-file")) cannotTell();
    else if (shardScanGap({ ...scan, pending: 0 }) !== null) cannotTell();
  } catch {
    cannotTell();
  }
}

/**
 * The shard's greatest record found by the prefix scan and verified, or
 * "empty" for a shard with no line, or "doubt" when the shard must be read
 * whole, or null when it cannot be opened as a regular file.
 */
function greatestByPrefix(
  shard: ShardEntry,
  partitionRoot: string,
  buffer: Buffer,
): StoreRecord | "empty" | "doubt" | null {
  let fd: number | null;
  try {
    fd = openRegularFileForRead(shard.path, partitionRoot);
  } catch {
    return null;
  }
  if (fd === null) return null;
  let best: { hlc: Hlc; text: string; id: string; offset: number } | null = null;
  let ties = 0;
  let lines = 0;
  try {
    let position = 0;
    let carried = 0;
    for (;;) {
      const n = readSync(fd, buffer, carried, READ_CHUNK_BYTES, position);
      if (n === 0) break;
      const filled = carried + n;
      const base = position - carried;
      position += n;
      let cursor = 0;
      for (;;) {
        const end = buffer.indexOf(NEWLINE, cursor);
        if (end === -1 || end >= filled) break;
        if (end - cursor + 1 > STORE_LINE_CAP_BYTES) return "doubt";
        const line = buffer.subarray(cursor, end);
        lines += 1;
        // Each line's prefix is garbage at once (`gc-hint.ts`), as the
        // fold's records are.
        gcHintTick();
        const head = line.subarray(0, PREFIX_BYTES).toString("utf8");
        const match = PREFIX_RE.exec(head);
        if (match === null || match[3] !== shard.device) return "doubt";
        if (line.includes(ESCAPE)) return "doubt";
        // A compaction record names the shards it replaces: the reader
        // takes it apart, so its shard is read whole.
        if (line.includes(COMPACTED_NAME)) return "doubt";
        if (hlcKeys(line) !== 1) return "doubt";
        const hlc = parseHlc(match[2]!);
        if (hlc === null) return "doubt";
        const order = best === null ? 1 : compareHlc(hlc, best.hlc);
        if (order > 0) {
          best = { hlc, text: match[2]!, id: match[1]!, offset: base + cursor };
          ties = 0;
        } else if (order === 0) {
          ties += 1;
        }
        cursor = end + 1;
      }
      // An unterminated rest is an append still arriving (the reader holds
      // it back too); a rest as long as the cap is a line the reader rejects.
      carried = filled - cursor;
      if (carried >= STORE_LINE_CAP_BYTES) return "doubt";
      buffer.copyWithin(0, cursor, filled);
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  if (best === null) return lines === 0 ? "empty" : "doubt";
  if (ties > 0) return "doubt";
  return verifiedAt(shard, partitionRoot, best) ?? "doubt";
}

/** Thrown to stop the reader after the first record it hands back. */
class FirstRecord {
  constructor(
    readonly record: StoreRecord,
    readonly offset: number,
  ) {}
}

/** The record the reader hands back at `offset` when it is the scanned one, else null. */
function verifiedAt(
  shard: ShardEntry,
  partitionRoot: string,
  scanned: { readonly text: string; readonly id: string; readonly offset: number },
): StoreRecord | null {
  try {
    scanShard(shard.path, { offset: scanned.offset, partitionRoot }, (read) => {
      throw new FirstRecord(read.record, read.offset);
    });
  } catch (stop) {
    if (!(stop instanceof FirstRecord)) return null;
    const { record, offset } = stop;
    if (offset !== scanned.offset) return null;
    if (record.id !== scanned.id || record.hlc !== scanned.text || record.device !== shard.device)
      return null;
    return record;
  }
  return null;
}
