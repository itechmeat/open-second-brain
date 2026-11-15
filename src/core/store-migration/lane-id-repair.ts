/**
 * Repair of lane entry ids an earlier release gave a page whose name ends
 * in a kept extension and `.md` (task 3.9, design D15 item 1).
 *
 * Before the lane path rule became a bijection, the migration imported
 * `Brain/<lane>/x.json.md` as entry `x.json`, the id of the file
 * `x.json` beside it, and both landed under one key. The rule now gives
 * the page the id `x.json.md`, so such a record is read by no path. Every
 * imported record carries the legacy path it came from (its `migrated`
 * mark), which tells the two apart:
 *
 *  - the page's latest record is written again under the id the rule
 *    gives its path, in the partition it lives in, unless that id holds a
 *    live entry already;
 *  - when the page's record is what the old key holds now, the old key is
 *    given back the latest record that is not the page's (the file
 *    `x.json`), or removed when there is none.
 *
 * A rollback writes each entry back to the legacy path of a mark that
 * names that entry under the current rule (`exporters.ts`
 * `laneEntryPath`), so the old key's restore or removal lands on `x.json`
 * and never on the page, which the snapshot restores. Only records with a
 * mark are moved: a writer of this tool
 * never wrote such a page itself. Every moved or restored record keeps the
 * body it copies, its `migrated` mark included, so the record under the
 * new id still names the legacy path it came from. Running it again finds
 * nothing to do.
 */

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import type { StorePartition } from "../store/constants.ts";
import { authorityRank, RegisterSet, TOMBSTONE, type RegisterEntry } from "../store/fold.ts";
import type { Authority } from "../store/constants.ts";
import { lanePlaceOf } from "../store/lane-paths.ts";
import {
  foldLaneEntries,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
  laneEntryKey,
  type LaneEntryValue,
} from "../store/lane-records.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import { withoutSeenRecording } from "../store/seen-shards.ts";
import { storeWrite } from "../store/store-write.ts";
import { resolveDeviceId } from "../config.ts";
import { deviceStateDirFor, partitionDir } from "../store/store-paths.ts";
import { listShards } from "../store/shard-list.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { migratedMark } from "./migration-records.ts";

const MD = ".md";
const BRAIN_PREFIX = `${BRAIN_ROOT_REL}/`;

/** One entry moved to the id its legacy path maps to. */
export interface LaneIdRepair {
  /** `<lane>/<entry>` the page's record was filed under. */
  readonly from: string;
  /** `<lane>/<entry>` it is written under now. */
  readonly to: string;
  /**
   * What the old key holds afterwards: its own value back, nothing, the
   * page filed under the id before it (`replaced`), or what it held.
   */
  readonly left: "restored" | "removed" | "replaced" | "unchanged";
}

interface Located {
  readonly record: StoreRecord;
  readonly partition: StorePartition;
}

/** The id an imported record's legacy path maps to now, when it is the `.md` page of its key. */
function pageTarget(record: StoreRecord, lane: string, entry: string): string | null {
  const mark = migratedMark(record);
  if (mark === null || !mark.key.startsWith(BRAIN_PREFIX) || !mark.key.endsWith(MD)) return null;
  const place = lanePlaceOf(mark.key.slice(BRAIN_PREFIX.length));
  if (place === null || place.lane !== lane || place.entry !== `${entry}${MD}`) return null;
  return laneEntryKey(place.lane, place.entry);
}

/**
 * The record a register of `entries` alone would hold (authority, then
 * fold order, a removal included), or undefined for none.
 */
function winnerOf(
  entries: ReadonlyArray<RegisterEntry<LaneEntryValue>>,
): RegisterEntry<LaneEntryValue> | undefined {
  const register = new RegisterSet<LaneEntryValue>();
  for (const entry of entries) register.offer("", entry);
  return register.get("")?.winner;
}

function higherAuthority(a: Authority, b: Authority): Authority {
  return authorityRank(a) >= authorityRank(b) ? a : b;
}

function located(
  record: StoreRecord,
  partition: StorePartition,
  kind: string,
  body: Record<string, unknown>,
): DualWriteRecord {
  return {
    stream: "events",
    kind,
    ...(record.agent !== undefined && record.agent !== null ? { agent: record.agent } : {}),
    private: partition === "private",
    located: { partition, content: kind === LANE_ENTRY_KIND },
    body,
  };
}

/** What one mis-filed key needs, worked out before anything is written. */
interface KeyPlan {
  readonly key: string;
  readonly lane: string;
  readonly entry: string;
  /** The page's latest record under this key. */
  readonly page: RegisterEntry<LaneEntryValue>;
  /** Its own id. */
  readonly to: string;
  /**
   * The records giving the old key its value back, or its removal, each
   * with the partition it lands in.
   */
  readonly old: ReadonlyArray<{
    readonly record: DualWriteRecord;
    readonly partition: StorePartition;
    readonly removal: boolean;
  }>;
  readonly left: LaneIdRepair["left"];
}

/** The repairs the records call for, with the records that carry them out, in order. */
export function planLaneIdRepairs(all: ReadonlyArray<Located>): {
  readonly repairs: ReadonlyArray<LaneIdRepair>;
  readonly records: ReadonlyArray<DualWriteRecord>;
  /** `from` of every repair a record of the `private` partition takes part in. */
  readonly privateKeys: ReadonlySet<string>;
} {
  const partitionOf = new Map(all.map((r) => [r.record.id, r.partition] as const));
  const fold = foldLaneEntries(all.map((r) => r.record));
  const plans = new Map<string, KeyPlan>();
  for (const [key, state] of fold.entries) {
    const live = state.history.filter((h) => h.value !== TOMBSTONE);
    const first = live[0];
    if (first === undefined) continue;
    const lane = first.record.body["lane"] as string;
    const entry = first.record.body["entry"] as string;
    const isPage = (h: RegisterEntry<LaneEntryValue>): boolean =>
      h.value !== TOMBSTONE && pageTarget(h.record, lane, entry) !== null;
    const pages = live.filter(isPage);
    // The page's own value: its records resolved as the register resolves
    // them (authority, then fold order), not its latest record.
    const page = winnerOf(pages);
    if (page === undefined) continue;
    const to = pageTarget(page.record, lane, entry)!;
    const old: Array<{ record: DualWriteRecord; partition: StorePartition; removal: boolean }> = [];
    let left: LaneIdRepair["left"] = "unchanged";
    const winner = state.history.find((h) => h.record.id === state.winner)!;
    if (!state.removed && isPage(winner)) {
      // The old key's own latest state, a removal included: a file deleted
      // before the page was filed over it stays deleted.
      const own = winnerOf(state.history.filter((h) => !isPage(h)));
      // At least the winner's authority, or a page imported with `human`
      // authority would keep winning and every pass repair again.
      const authority = higherAuthority(own?.authority ?? winner.authority, winner.authority);
      const pagePartition = partitionOf.get(winner.record.id) ?? "shared";
      const removal = (partition: StorePartition) => ({
        record: located(winner.record, partition, LANE_ENTRY_REMOVE_KIND, {
          authority,
          lane,
          entry,
        }),
        partition,
        removal: true,
      });
      if (own === undefined || own.value === TOMBSTONE) {
        old.push(removal(pagePartition));
        left = "removed";
      } else {
        const ownPartition = partitionOf.get(own.record.id) ?? "shared";
        // A file restored in `private` over a page that lives in `shared`:
        // a machine that holds only `shared` must see the page leave too.
        if (pagePartition === "shared" && ownPartition === "private") old.push(removal("shared"));
        old.push({
          record: located(own.record, ownPartition, LANE_ENTRY_KIND, {
            ...own.record.body,
            authority,
          }),
          partition: ownPartition,
          removal: false,
        });
        left = "restored";
      }
    }
    plans.set(key, { key, lane, entry, page, to, old, left });
  }
  const repairs: LaneIdRepair[] = [];
  const privateKeys = new Set<string>();
  for (const [key, plan] of plans) {
    const state = fold.entries.get(key)!;
    const involved = [plan.page.record.id, ...state.history.map((h) => h.record.id)];
    if (involved.some((id) => partitionOf.get(id) === "private")) privateKeys.add(key);
  }
  const olds: DualWriteRecord[] = [];
  const moves: DualWriteRecord[] = [];
  /** Ids a page moves into in this pass, with the partition the move lands in. */
  const replaced = new Map<string, StorePartition>();
  for (const plan of plans.values()) {
    // The page is written under its own id only when that id has no
    // history of its own: an id that was written, or removed since, is the
    // user's to keep that way, so a page deleted after its repair stays
    // deleted. An id that holds nothing but a page filed there from the id
    // after it (`x.json.md.md` under `x.json.md`) is no history of its own:
    // that page moves on in this pass, and this one takes its place.
    const target = fold.entries.get(plan.to);
    const targetPlan = plans.get(plan.to);
    const onlyMisfiled =
      target !== undefined &&
      targetPlan !== undefined &&
      targetPlan.left === "removed" &&
      target.history.every(
        (h) =>
          h.value !== TOMBSTONE && pageTarget(h.record, targetPlan.lane, targetPlan.entry) !== null,
      );
    const targetFresh = target === undefined || onlyMisfiled;
    const movePartition = partitionOf.get(plan.page.record.id) ?? "shared";
    if (targetFresh) {
      const [toLane, ...rest] = plan.to.split("/");
      const targetWinner =
        target === undefined
          ? undefined
          : target.history.find((h) => h.record.id === target.winner);
      moves.push(
        located(plan.page.record, movePartition, LANE_ENTRY_KIND, {
          ...plan.page.record.body,
          lane: toLane,
          entry: rest.join("/"),
          authority: higherAuthority(
            plan.page.authority,
            targetWinner?.authority ?? plan.page.authority,
          ),
        }),
      );
      // The page this one replaces leaves in this pass: no removal of its
      // id in the partition the move lands in, which the move clears.
      if (onlyMisfiled) replaced.set(plan.to, movePartition);
    }
    if (plan.left !== "unchanged" || targetFresh) {
      repairs.push({ from: plan.key, to: plan.to, left: plan.left });
    }
  }
  for (const plan of plans.values()) {
    for (const { record, partition, removal } of plan.old) {
      // A removal in another partition than the move's stays: a machine
      // that holds only that partition must see the old page go.
      if (removal && replaced.get(plan.key) === partition) continue;
      olds.push(record);
    }
  }
  return {
    repairs: repairs.map((r) => (replaced.has(r.from) ? { ...r, left: "replaced" as const } : r)),
    // The old keys' restores and removals first, then the moves.
    records: [...olds, ...moves],
    privateKeys,
  };
}

/** How many times a plan is made again from a read that moved before it is given up. */
const REPLAN_ATTEMPTS = 3;

/** Whether two reads hold the same lane records. */
function sameRecords(a: ReadonlyArray<Located>, b: ReadonlyArray<Located>): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((r) => r.record.id));
  return b.every((r) => ids.has(r.record.id));
}

/** The device-local marker of a store whose lane ids were repaired on this machine. */
const REPAIRED_MARKER = "lane-ids-repaired.json";

/**
 * Find and repair the mis-filed pages of the configured store (see the
 * module comment). Returns what it repaired; nothing when the store
 * cannot be read or holds none.
 *
 * Runs only on a machine that holds `private`: on one without it, a
 * file's own record in `private` is invisible and the repair would
 * remove the file's id over it. A device-local marker records a finished
 * pass that read every shard in full, with a stamp of the `events`
 * shards it read: a later dream pass reads the stream again only once
 * something new arrived in it (a late import of a machine still on the
 * earlier release included), and a pass whose write fails, or that could
 * not read a shard, leaves no marker and runs again.
 */
export function repairLaneEntryIds(vault: string | null): ReadonlyArray<LaneIdRepair> {
  const store = configuredStore();
  if (store === null || !store.partitions.has("private")) return [];
  const marker = join(deviceStateDirFor(store.storeId, processDirsEnv()), REPAIRED_MARKER);
  // Stamped before the read, over the shards of the other devices only:
  // a mis-filed record comes from another machine's import, never from
  // this machine, whose own writes (this pass's included) do not re-arm
  // the repair, and a shard that arrives after the read moves the stamp.
  const stamp = eventsStamp(store);
  if (readMarkerStamp(marker) === stamp) return [];
  let { all, complete } = laneRecordsOf(store);
  // A read that missed a shard (unreadable, gone since this machine read
  // it, or holding a record whose blob has not arrived) may have missed
  // the file beside a page, or a removal: nothing is written from it, and
  // the next pass reads again.
  if (!complete) return [];
  let { repairs, records } = planLaneIdRepairs(all);
  // Planned from a read another writer may have moved past (a person's
  // edit of an id the plan touches): the plan is written only once a read
  // right before the write finds the same lane records, and planned again
  // from that read otherwise, a few times at most.
  for (let attempt = 0; records.length > 0; attempt++) {
    const again = laneRecordsOf(store);
    if (!again.complete) return [];
    if (sameRecords(all, again.all)) break;
    if (attempt >= REPLAN_ATTEMPTS) return [];
    ({ all, complete } = again);
    ({ repairs, records } = planLaneIdRepairs(all));
  }
  if (records.length > 0) storeWrite(() => records, { vault });
  mkdirSync(dirname(marker), { recursive: true });
  atomicWriteFileSync(
    marker,
    `${JSON.stringify({ version: 3, repaired: repairs.length, events: stamp }, null, 2)}\n`,
  );
  return repairs;
}

/** The `events` stamp a marker recorded, or null for none (or one of an older version). */
function readMarkerStamp(marker: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { events?: unknown };
    const { version, events } = parsed as { version?: unknown; events?: unknown };
    return version === 3 && typeof events === "string" ? events : null;
  } catch {
    return null;
  }
}

/**
 * A digest of the `events` shards of the held partitions that other
 * devices write (path, size, mtime): it moves whenever another machine's
 * record arrives, a late import of a machine still on the earlier release
 * included, and never for this machine's own writes.
 */
function eventsStamp(store: NonNullable<ReturnType<typeof configuredStore>>): string {
  let own = "";
  try {
    own = resolveDeviceId();
  } catch {
    // No device id: every shard counts.
  }
  const lines: string[] = [];
  for (const partition of [...store.partitions].toSorted()) {
    for (const shard of listShards(partitionDir(store.root, partition), { stream: "events" })) {
      if (own !== "" && shard.device === own) continue;
      let stamp = "missing";
      try {
        const stat = statSync(shard.path);
        stamp = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        // gone between the listing and the stat: reads as changed
      }
      lines.push(`${partition}/${shard.rel}=${stamp}`);
    }
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The lane records of every held partition, and whether every shard was read in full. */
function laneRecordsOf(store: NonNullable<ReturnType<typeof configuredStore>>): {
  readonly all: ReadonlyArray<Located>;
  readonly complete: boolean;
} {
  const all: Located[] = [];
  let complete = true;
  for (const partition of store.partitions) {
    const read = readStreamRecords(store.root, partition, { stream: "events" });
    if (read.unreadable.length > 0 || read.skippedPending) complete = false;
    for (const record of read.records) {
      if (record.kind === LANE_ENTRY_KIND || record.kind === LANE_ENTRY_REMOVE_KIND) {
        all.push({ record, partition });
      }
    }
  }
  return { all, complete };
}

/**
 * The mis-filed pages of the configured store as this machine reads it,
 * written nowhere: what the doctor reports (`lane-id-check.ts`), on any
 * machine, so a store no machine of which holds `private` (where the
 * repair never runs) shows them too. `sharedOnly` leaves out every repair
 * a record of the `private` partition takes part in.
 */
export function misfiledLaneIds(
  configPath?: string,
  options: { readonly sharedOnly?: boolean } = {},
): ReadonlyArray<LaneIdRepair> {
  const store = configuredStore(configPath);
  if (store === null) return [];
  return withoutSeenRecording(() => {
    const { repairs, privateKeys } = planLaneIdRepairs(laneRecordsOf(store).all);
    // `sharedOnly`: what a caller below local reach may be told, the
    // repairs no record of the `private` partition takes part in.
    return options.sharedOnly === true ? repairs.filter((r) => !privateKeys.has(r.from)) : repairs;
  });
}
