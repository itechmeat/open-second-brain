/**
 * The whole state space of the look for another device's migration mark
 * (change auto-store-migration, design D7), against one oracle stated as
 * invariants. `judgeMarkScan` is pure: the listing and every read are
 * given to it, so each row builds them from its state and nothing touches
 * a disk.
 *
 * State, per other device (two of them, so "found elsewhere" and the
 * order of devices are covered):
 *  - its newest shards: absent (the device has no shard), unreadable,
 *    readable;
 *  - the mark: absent, inside the window, at the window's first byte, cut
 *    by the window start (the line began before the window and could not
 *    be read back to its start), cut by a torn last line (sync is still
 *    writing it), before the window;
 *  - later legacy days of that device after the mark's day: none, one,
 *    two or more;
 * and the listing: complete, failed.
 *
 * Impossible combinations, left out: a device with no shard has no mark
 * and no later day (one state instead of eighteen).
 *
 * Invariants (the oracle):
 *  1. A listing that failed answers incomplete, never "no mark".
 *  2. A mark the scan read whole (inside the window, or at its first
 *     byte) of a device with at most one later day is found, and every
 *     mark answered is such a mark of the device it names.
 *  3. A read that could hide a mark (a shard that cannot be read, a
 *     window cut at its start, a torn last line) makes the answer
 *     incomplete unless a mark is found elsewhere.
 *  4. Everything read whole and no mark in it: "no mark", complete. A
 *     mark before the window, or followed by two or more later days, is
 *     past the bounded look and does not count (design, "the look is
 *     bounded").
 *  5. The answer is the same whatever the order of the listing.
 */
import { describe, expect, test } from "bun:test";

import {
  judgeMarkScan,
  MARK_SHARDS_PER_DEVICE,
  type MarkListing,
  type MarkScan,
  type MarkShardFile,
  type ShardTail,
} from "../../../src/core/store-migration/auto-probe.ts";

const SHARDS = ["absent", "unreadable", "readable"] as const;
const MARKS = ["absent", "inside", "first-byte", "cut-start", "torn", "before"] as const;
const LATER = [0, 1, 2] as const;

type Shards = (typeof SHARDS)[number];
type Mark = (typeof MARKS)[number];
type Later = (typeof LATER)[number];

interface DeviceState {
  readonly device: string;
  readonly shards: Shards;
  readonly mark: Mark;
  readonly later: Later;
}

const OWN = "dev-a";

const MARK_LINE = (device: string): string =>
  JSON.stringify({
    ts: "2026-11-17T10:00:00Z",
    kind: "snapshot",
    payload: { run_id: `run-${device}`, reason: "store-migration" },
  });

const NOTE = JSON.stringify({ ts: "2026-11-17T10:00:00Z", kind: "note", payload: { t: "x" } });

/** The shard date of day `n` after 2020-01-01. */
function day(n: number): string {
  return new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The day of the mark's shard; later days follow it. */
const MARK_DAY = 10;

/** The tail of the mark's shard, as a read that succeeded returns it. */
function markShardTail(d: DeviceState): ShardTail {
  const mark = MARK_LINE(d.device);
  switch (d.mark) {
    case "absent":
    case "before":
      return { ok: true, text: `${NOTE}\n`, cutStart: false };
    case "inside":
      return { ok: true, text: `${NOTE}\n${mark}\n`, cutStart: false };
    case "first-byte":
      return { ok: true, text: `${mark}\n${NOTE}\n`, cutStart: false };
    case "cut-start":
      return { ok: true, text: `${NOTE}\n`, cutStart: true };
    case "torn":
      return { ok: true, text: `${NOTE}\n${mark.slice(0, mark.length - 12)}`, cutStart: false };
  }
}

/** The files and reads one device contributes. */
function deviceShards(d: DeviceState): Array<{ file: MarkShardFile; tail: ShardTail }> {
  if (d.shards === "absent") return [];
  const out: Array<{ file: MarkShardFile; tail: ShardTail }> = [];
  for (let n = 0; n <= d.later; n++) {
    const name = `${day(MARK_DAY + n)}.${d.device}.jsonl`;
    const tail: ShardTail =
      d.shards === "unreadable"
        ? { ok: false, error: `EIO: ${name}` }
        : n === 0
          ? markShardTail(d)
          : { ok: true, text: `${NOTE}\n`, cutStart: false };
    out.push({ file: { device: d.device, name, path: `/log/${name}` }, tail });
  }
  return out;
}

function scan(devices: ReadonlyArray<DeviceState>, listed: boolean, order: number): MarkScan {
  const all = devices.flatMap(deviceShards);
  const tails = new Map(all.map((s) => [s.file.path, s.tail]));
  let files = all.map((s) => s.file);
  if (order === 1) files = files.toReversed();
  if (order === 2) files = files.toSorted((x, y) => (x.path < y.path ? -1 : 1)).toReversed();
  const listing: MarkListing = listed ? { ok: true, files } : { ok: false, error: "EACCES" };
  return judgeMarkScan(listing, OWN, (path) => {
    const tail = tails.get(path);
    if (tail === undefined) throw new Error(`read of a shard the listing does not name: ${path}`);
    return tail;
  });
}

/** Whether the look covers the mark's shard (it is among the newest shards read). */
function markShardRead(d: DeviceState): boolean {
  return d.shards !== "absent" && d.later < MARK_SHARDS_PER_DEVICE;
}

/** A mark the scan reads whole. */
function visible(d: DeviceState): boolean {
  return (
    d.shards === "readable" && markShardRead(d) && (d.mark === "inside" || d.mark === "first-byte")
  );
}

/** A read of this device that could hide a mark. */
function hiding(d: DeviceState): boolean {
  if (d.shards === "unreadable") return true;
  return (
    d.shards === "readable" && markShardRead(d) && (d.mark === "cut-start" || d.mark === "torn")
  );
}

function deviceStates(device: string): DeviceState[] {
  const out: DeviceState[] = [{ device, shards: "absent", mark: "absent", later: 0 }];
  for (const shards of SHARDS) {
    if (shards === "absent") continue;
    for (const mark of MARKS) for (const later of LATER) out.push({ device, shards, mark, later });
  }
  return out;
}

interface Row {
  readonly name: string;
  readonly devices: ReadonlyArray<DeviceState>;
  readonly listed: boolean;
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const b of deviceStates("dev-b")) {
    for (const c of deviceStates("dev-c")) {
      for (const listed of [true, false]) {
        const label = (d: DeviceState): string => `${d.device}:${d.shards}/${d.mark}/+${d.later}`;
        out.push({
          name: `${label(b)} ${label(c)} ${listed ? "listed" : "listing-failed"}`,
          devices: [b, c],
          listed,
        });
      }
    }
  }
  return out;
}

/** Every invariant the answer breaks for `row`, as text; empty when none. */
function violations(row: Row): string[] {
  const out: string[] = [];
  const answer = scan(row.devices, row.listed, 0);
  const anyVisible = row.devices.some(visible);
  const anyHiding = row.devices.some(hiding);
  if (!row.listed) {
    if (answer.mark !== null || answer.incomplete === null) out.push("1: a failed listing");
    return out;
  }
  if (anyVisible && answer.mark === null) out.push("2: a whole mark not found");
  if (answer.mark !== null) {
    const named = row.devices.find((d) => d.device === answer.mark!.device);
    if (named === undefined || !visible(named)) out.push("2: a mark answered that is not one");
    if (answer.incomplete !== null) out.push("2: a mark answered as incomplete");
  }
  if (!anyVisible && anyHiding && (answer.mark !== null || answer.incomplete === null)) {
    out.push("3: a read that could hide a mark answered no mark");
  }
  if (!anyVisible && !anyHiding && (answer.mark !== null || answer.incomplete !== null)) {
    out.push("4: everything read whole, yet not a complete no-mark");
  }
  for (const order of [1, 2]) {
    if (JSON.stringify(scan(row.devices, row.listed, order)) !== JSON.stringify(answer)) {
      out.push(`5: the answer depends on the listing order (${order})`);
    }
  }
  return out;
}

describe("the mark scan, over its whole state space", () => {
  const all = rows();

  test("covers every row", () => {
    // (1 + 2 x 6 x 3) device states per device, two devices, two listings.
    expect(all.length).toBe(37 * 37 * 2);
  });

  test("keeps every invariant in every row", () => {
    const broken = all.flatMap((row) => violations(row).map((v) => `${row.name}: ${v}`));
    expect(broken).toEqual([]);
  });
});
