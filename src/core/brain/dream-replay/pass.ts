/**
 * The replay inside a live pass (design D1): whether this pass replays,
 * the folded `dream-replay` stream it starts from, and the writes of its
 * records. A dry run, a preview, a brain not served from the store and a
 * store without the `shared` partition never get one; their pass is the
 * single window of today, as before this change.
 */

import { appendRecord } from "../../store/appender.ts";
import type { StorePartition } from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import type { StoreHandle } from "../../store/store-open.ts";
import type { DreamOptions } from "../dream-types.ts";
import { foldDreamReplay, type DreamReplayState } from "./fold.ts";
import { DREAM_REPLAY_STREAM } from "./records.ts";

export interface DreamReplayPass {
  readonly store: StoreHandle;
  /** The run id of the pass: a fact about the run, never part of a window's identity. */
  readonly run: string;
  /** Identity written on each record envelope. */
  readonly writer: string;
  /** The real moment of the run. */
  readonly now: Date;
  /** The dream owner's device, or null on a brain with no owner. */
  readonly owner: string | null;
  /** The machine config the pass was given: every read of the replay resolves its store from it. */
  readonly configPath?: string;
}

/** Records of the stream could not all be read: the replay does not guess (unknown is not empty). */
export class DreamReplayUnreadableError extends Error {
  constructor(readonly shards: ReadonlyArray<string>) {
    super(`dream replay: the dream-replay stream is incomplete here (${shards.join(", ")})`);
    this.name = "DreamReplayUnreadableError";
  }
}

/** The replay of a live pass, or null when this pass is the single window of today. */
export function openReplayPass(
  vault: string | null,
  store: StoreHandle | null,
  opts: DreamOptions,
  now: Date,
  run: string,
  owner: string | null = null,
): DreamReplayPass | null {
  if (store === null || opts.dryRun === true || opts.previewReadable !== undefined) return null;
  if (!store.partitions.has("shared")) return null;
  const configPath = opts.configPath;
  const context = configPath !== undefined ? { configPath } : {};
  if (vault !== null && !isStoreOnly({ vault, ...context })) return null;
  return { store, run, writer: opts.agentName?.trim() || "o2b", now, owner, ...context };
}

/** The partitions a replay record may live in, in the order they are read. */
const REPLAY_PARTITIONS: ReadonlyArray<StorePartition> = ["shared", "private"];

/** What one read of the stream found, over every held partition. */
export interface ReplayRead {
  readonly records: ReadonlyArray<StoreRecord>;
  /** `<partition>/<shard>` of every shard that could not be read. */
  readonly unreadable: ReadonlyArray<string>;
  /** Whether a record was left out because its body is a pending blob. */
  readonly skippedPending: boolean;
}

/**
 * The records of the `dream-replay` stream in every partition this device
 * holds: the private part of a window (`privacy.ts`) is folded with the
 * shared part wherever both are held.
 */
export function readReplayRecords(store: {
  readonly root: string;
  readonly partitions: ReadonlySet<StorePartition>;
}): ReplayRead {
  const records: StoreRecord[] = [];
  const unreadable: string[] = [];
  let skippedPending = false;
  for (const partition of REPLAY_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    const read = readStreamRecords(store.root, partition, { stream: DREAM_REPLAY_STREAM });
    records.push(...read.records);
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
    if (read.skippedPending) skippedPending = true;
  }
  return { records, unreadable, skippedPending };
}

/** The folded stream as this device holds it now. */
export function readReplayState(pass: {
  readonly store: Parameters<typeof readReplayRecords>[0];
}): DreamReplayState {
  const read = readReplayRecords(pass.store);
  if (read.unreadable.length > 0) throw new DreamReplayUnreadableError(read.unreadable);
  // A record whose body is a quarantined pending blob opens no gap, but
  // the record is there: folding without it would plan an open window
  // again or lose an admission's late records.
  if (read.skippedPending) {
    throw new DreamReplayUnreadableError([
      `${DREAM_REPLAY_STREAM} (a record whose body is pending)`,
    ]);
  }
  return foldDreamReplay(read.records);
}

/**
 * Append one replay record; returns its id. `isPrivate` sends it to the
 * `private` partition when this device holds it; a device without it read
 * nothing private, so it has nothing private to write.
 */
export function writeReplayRecord(
  pass: DreamReplayPass,
  kind: string,
  body: object,
  isPrivate = false,
): string {
  return appendRecord(pass.store, {
    partition: isPrivate && pass.store.partitions.has("private") ? "private" : "shared",
    stream: DREAM_REPLAY_STREAM,
    kind,
    agent: pass.writer,
    // Plain JSON: a record body is the object as written.
    body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
  }).record.id;
}
