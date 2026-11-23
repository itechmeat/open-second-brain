/**
 * Admission of a window (design D3): read every `events` and `log` shard
 * from the positions the previous window froze, give the new records
 * their effective times, and freeze the new boundary. The record this
 * builds is written before anything depends on it.
 *
 * The admission window of a record is defined, not observed (spec "The
 * reference is daily runs over the same admission history"): a record
 * first seen when its event day is already covered is late and is judged
 * from the start of the window that first sees it; a record dated after
 * the real moment of admission is judged at that moment; every other
 * record keeps its own time, including one dated inside a part of the gap
 * not replayed yet (no pass ran then, so its own day is its admission).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { StorePartition } from "../../store/constants.ts";
import { partitionDir } from "../../store/store-paths.ts";
import { parseWikilink } from "../wikilink.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { eventTimeOf, isInputRecord } from "../../store/read/read-view.ts";
import { EMPTY_DIGEST, readShardsFrom, type ShardPosition } from "../../store/read/shards-from.ts";
import {
  GAP_LEAVE_OUT_MS,
  windowBounds,
  type AdmissionGap,
  type AdmissionLeftOut,
  type AdmittedTime,
  type DreamAdmissionBody,
} from "./records.ts";

/** The streams whose positions a window keeps: captures and the log. */
export const ADMITTED_STREAMS = Object.freeze([{ stream: "events" }, { stream: "log" }] as const);

export interface AdmitInput {
  readonly root: string;
  readonly partitions: Iterable<StorePartition>;
  readonly day: string;
  readonly window: string;
  /** The newest covered day before this window, or null. */
  readonly lastCovered: string | null;
  /** The boundary of the previous window; empty before the first. */
  readonly positions: ReadonlyArray<ShardPosition>;
  /** The real moment of the admission. */
  readonly now: Date;
  /** The newest earlier admission: its gaps and left-out sources, with since when. */
  readonly previous: Pick<DreamAdmissionBody, "gaps" | "left_out"> | null;
  readonly run: string;
}

function keyOf(partition: string, shard: string): string {
  return `${partition}/${shard}`;
}

/** Since when each source of `admission` has been incomplete (its gaps and the shards it left out). */
export function incompleteSinceOf(
  admission: Pick<DreamAdmissionBody, "gaps" | "left_out"> | null,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const gap of admission?.gaps ?? []) out.set(keyOf(gap.partition, gap.shard), gap.since);
  for (const left of admission?.left_out ?? []) {
    out.set(keyOf(left.partition, left.shard), left.since);
  }
  return out;
}

/** The rule an application names (`pref-<slug>`), or null for any other record. */
function ruleOf(record: StoreRecord): string | null {
  if (record.kind === "preference-evidence") {
    const id = record.body["preference"];
    return typeof id === "string" ? id : null;
  }
  if (record.kind === "log-event") {
    const inner = record.body["body"];
    const target =
      inner !== null && typeof inner === "object"
        ? (inner as Record<string, unknown>)["preference"]
        : undefined;
    if (typeof target !== "string") return null;
    const id = parseWikilink(target) ?? target;
    return id.startsWith("pref-") ? id : null;
  }
  return null;
}

/** Whether an admission gives nothing but positions: no late, clamped, incomplete or rebased record. */
export function isPlainAdmission(body: DreamAdmissionBody): boolean {
  return (
    body.late.length === 0 &&
    body.clamped.length === 0 &&
    body.gaps.length === 0 &&
    body.left_out.length === 0 &&
    body.rebased === null
  );
}

/** An admission, and which of its late and clamped records were read from `private`. */
export interface AdmittedWindow {
  readonly body: DreamAdmissionBody;
  readonly privateIds: ReadonlySet<string>;
  /** Input records read past the previous boundary and not rebased: new to the replay. */
  readonly fresh: number;
}

/** The admission record of the window of `input.day`. */
export function admitWindow(input: AdmitInput): AdmittedWindow {
  const { from, to } = windowBounds(input.day);
  const nowIso = input.now.toISOString();
  const incompleteSince = incompleteSinceOf(input.previous);
  const positions = new Map<string, ShardPosition>();
  for (const p of input.positions) positions.set(keyOf(p.partition, p.shard), p);
  // A gap reported on a shard no admission has read (a new shard whose
  // first read missed a blob) has no position, so the reader would pass
  // over it once the shard is no longer listed. It is read from its start
  // instead: the reader then reports it read, still a gap, replaced or
  // missing, and a missing one stays a gap until the three-day rule
  // leaves it out.
  const unread = new Set<string>();
  const from0: ShardPosition[] = [];
  for (const gap of input.previous?.gaps ?? []) {
    const key = keyOf(gap.partition, gap.shard);
    if (positions.has(key) || unread.has(key)) continue;
    unread.add(key);
    from0.push({
      partition: gap.partition as StorePartition,
      stream: gap.stream,
      device: gap.shard.split("/").at(-2) ?? "",
      shard: gap.shard,
      offset: 0,
      prefix_hash: EMPTY_DIGEST,
    });
  }
  const read = readShardsFrom({
    root: input.root,
    partitions: input.partitions,
    streams: ADMITTED_STREAMS,
    positions: [...input.positions, ...from0],
    keep: isInputRecord,
  });
  // An unread shard a compaction replaced and removed: its records are in
  // the shards the compaction wrote, read as new. Nothing of it was read,
  // so it is neither rebased nor kept.
  const replacedUnread = (shard: (typeof read.shards)[number]): boolean =>
    shard.status === "replaced" &&
    unread.has(keyOf(shard.partition, shard.shard)) &&
    !existsSync(join(partitionDir(input.root, shard.partition as StorePartition), shard.shard));
  const gaps: AdmissionGap[] = [];
  const leftOut: AdmissionLeftOut[] = [];
  const late: AdmittedTime[] = [];
  const clamped: AdmittedTime[] = [];
  const rebasedShards: string[] = [];
  const privateIds = new Set<string>();
  let seen = 0;
  let fresh = 0;
  // Shards a compaction wrote instead of one with a position: their
  // records are rebased, not read as new.
  const replacing = new Set<string>();
  for (const shard of read.shards) {
    if (shard.status === "replaced" && !replacedUnread(shard)) {
      for (const into of shard.into ?? []) replacing.add(keyOf(shard.partition, into));
    }
  }
  const classify = (record: StoreRecord, rebase: boolean, partition: string): void => {
    if (partition === "private") privateIds.add(record.id);
    if (!rebase) fresh += 1;
    const at = eventTimeOf(record);
    if (at === null) return;
    const day = at.slice(0, 10);
    // Late: dated on a covered day before this window (a record of today
    // read by a later evaluation of today is not late).
    if (input.lastCovered !== null && day <= input.lastCovered && day < input.day) {
      // Already covered: a rebased record is taken as seen, a new one is late.
      if (rebase) seen += 1;
      else {
        const subject = ruleOf(record);
        late.push({
          id: record.id,
          at: from,
          ...(subject !== null ? { subject, event_at: at } : {}),
        });
      }
      return;
    }
    if (Date.parse(at) > input.now.getTime()) clamped.push({ id: record.id, at: nowIso });
  };
  for (const shard of read.shards) {
    const key = keyOf(shard.partition, shard.shard);
    if (replacedUnread(shard)) continue;
    if (shard.status === "gap" || shard.status === "missing") {
      const since = incompleteSince.get(key) ?? nowIso;
      const before = positions.get(key);
      if (input.now.getTime() - Date.parse(since) >= GAP_LEAVE_OUT_MS) {
        leftOut.push({
          partition: shard.partition,
          stream: shard.stream,
          shard: shard.shard,
          offset: before?.offset ?? 0,
          since,
        });
      } else {
        gaps.push({
          partition: shard.partition,
          stream: shard.stream,
          shard: shard.shard,
          reason: shard.gap ?? "the shard is no longer listed and no compaction replaced it",
          since,
        });
      }
      continue;
    }
    const rebase =
      shard.status === "mismatch" ||
      shard.status === "replaced" ||
      (replacing.has(key) && !positions.has(key));
    if (rebase) rebasedShards.push(key);
    for (const record of shard.records) classify(record, rebase, shard.partition);
    // A replaced shard that is gone keeps no position: its records live in
    // the shards that replaced it now.
    if (
      shard.status === "replaced" &&
      !existsSync(join(partitionDir(input.root, shard.partition as StorePartition), shard.shard))
    ) {
      positions.delete(key);
      continue;
    }
    positions.set(key, shard.position);
  }
  const body: DreamAdmissionBody = {
    day: input.day,
    window: input.window,
    from,
    to,
    positions: [...positions.values()].toSorted((a, b) =>
      keyOf(a.partition, a.shard) < keyOf(b.partition, b.shard) ? -1 : 1,
    ),
    gaps,
    late,
    clamped,
    left_out: leftOut,
    rebased: rebasedShards.length > 0 ? { shards: rebasedShards, seen } : null,
    admitted_at: nowIso,
    run: input.run,
  };
  return { body, privateIds, fresh };
}
