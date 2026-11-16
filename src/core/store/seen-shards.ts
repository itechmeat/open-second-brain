/**
 * The shards this machine has seen, per store (design D14, fail closed).
 *
 * A shard is append-only and the store itself never deletes one (only
 * compaction will, and it announces the shards it replaces). So a shard
 * this machine has read before and that is now absent was taken away
 * underneath the store: a sync tool mid-transfer, a user, a broken disk.
 * A reader that treated it as "no records" would let a decision that
 * depends on a record in it (a deny rule, a privacy partition, a capture
 * exclusion) fail open. Every listing of a stream therefore records the
 * shards it saw in a small device-local ledger, and reports the shards
 * the ledger names that the listing no longer finds, so the reader can
 * name them as unreadable.
 *
 * Two removals are expected and never reported: a shard a `compacted`
 * record names in `replaces`, and every shard of a device a human retired
 * (`device-retire` in `shared` settings), whose files may be cleaned away.
 * A shard dropped for either reason also leaves the ledger.
 *
 * The ledger lives in the store's device-local directory
 * (`<state>/open-second-brain/stores/<store id>/seen-shards-<root hash>.json`),
 * so a store recreated under the same root, or a copy of a store at another
 * root, starts a fresh one. Every read-modify-write of the ledger runs
 * under the device-local lock of the ledger file (`local-lock.ts`), and
 * re-reads the file inside it, so two processes on one machine never
 * interleave: a stale write from {@link trackSeenShards} cannot bring
 * back the entries a partition leave just cleared, and a leave cannot
 * drop a shard another process just recorded. The lock guards only the
 * ledger file and takes no other lock inside it, so a reader that already
 * holds a store lock can take it. A tracking update stays best-effort: it
 * waits at most {@link TRACK_LOCK_BUDGET_MS} (a read must not stall on a
 * lock a crashed process left), and a lock still busy then leaves the
 * change queued in the process: the next update of the ledger writes it
 * with its own, so a skip delays tracking a shard, it does not drop it,
 * unless the process ends before its next update: the queue lives in the
 * process, and only the file is seen by another one. After a
 * skip behind a lock one holder kept through the whole wait (a crashed
 * process's) the process leaves the ledger alone for
 * {@link TRACK_BACKOFF_MS} without waiting, so a hook that lists several
 * streams behind it loses the wait once, not once per listing; a lock
 * other processes take and release in turn backs nothing off.
 * A surface that promises to write nothing (doctor, the status block)
 * runs inside {@link withoutSeenRecording}: it still reports a shard the
 * ledger names that is gone, and records nothing. Leaving a partition
 * (`partition-leave.ts`) clears its entries.
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { atomicWriteText } from "../fs-atomic.ts";
import { compareCodeUnits } from "./compare.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { SEEN_SHARDS_FILE, STORE_PARTITIONS, type StorePartition } from "./constants.ts";
import { latestRetirements } from "./device-retirement.ts";
import type { StoreRecord } from "./envelope.ts";
import { readShard } from "./reader.ts";
import { listShards } from "./shard-list.ts";
import { readStoreId } from "./store-open.ts";
import { deviceStateDirFor, partitionDir } from "./store-paths.ts";

/** What part of a partition a listing covered. */
export interface SeenScope {
  /** Partition-relative prefix of the listed stream (`events/`, `ledgers/x/`), or `""` for all. */
  readonly prefix: string;
  /** Only this device's shards were asked for. */
  readonly device?: string;
  /** Only shards whose month passes this test were asked for. */
  readonly month?: (month: string) => boolean;
}

type Ledger = Map<StorePartition, Set<string>>;

interface Loaded {
  readonly stamp: string;
  readonly ledger: Ledger;
}

const loaded = new Map<string, Loaded>();

/**
 * The device-local lock, loaded on the first ledger write: every stream
 * read imports this module, and a hot path that only reads (a hook with
 * its feature off) must not load the lock modules for it.
 */
function withLocalLock<T>(lockTarget: string, fn: () => T, budgetMs?: number): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lock = require("./local-lock.ts") as typeof import("./local-lock.ts");
  return lock.withLocalLock(lockTarget, fn, budgetMs);
}

/** Longest wait of a tracking update for the ledger lock; a leave waits the full lock budget. */
const TRACK_LOCK_BUDGET_MS = 500;

/** How long a tracking update that found the lock busy keeps the process off it. */
const TRACK_BACKOFF_MS = 10_000;

/** Ledger paths whose lock was found busy, with the time the back-off ends. */
const busyUntil = new Map<string, number>();

/** One tracking change: shards a listing saw, and shards it found replaced. */
interface TrackChange {
  readonly partitionRoot: string;
  readonly partition: StorePartition;
  readonly fresh: ReadonlyArray<string>;
  readonly expected: ReadonlyArray<string>;
}

/** Tracking changes of this process an update could not write yet, per ledger path. */
const pending = new Map<string, TrackChange[]>();

/** The most changes kept for one ledger path while its lock stays busy. */
const PENDING_MAX = 1_000;

/**
 * Apply `changes` to `ledger`, leaving out those of a partition this
 * machine no longer holds (its identity file is gone): a change queued
 * before `o2b store partition leave` cleared the partition must not bring
 * its entries back.
 */
function applyChanges(ledger: Ledger, changes: ReadonlyArray<TrackChange>): void {
  const held = new Map<string, boolean>();
  for (const change of changes) {
    let holds = held.get(change.partitionRoot);
    if (holds === undefined) {
      try {
        holds = readStoreId(change.partitionRoot) !== null;
      } catch {
        holds = false;
      }
      held.set(change.partitionRoot, holds);
    }
    if (!holds) continue;
    const own = ledger.get(change.partition) ?? new Set<string>();
    for (const rel of change.fresh) own.add(rel);
    for (const rel of change.expected) own.delete(rel);
    ledger.set(change.partition, own);
  }
}

/** Depth of read-only scopes in this process. */
let readOnlyDepth = 0;

/**
 * Run `fn` without recording any shard as seen: the reads inside it still
 * report the shards the ledger already names that are gone.
 */
export function withoutSeenRecording<T>(fn: () => T): T {
  readOnlyDepth += 1;
  try {
    return fn();
  } finally {
    readOnlyDepth -= 1;
  }
}

function isPartition(value: string): value is StorePartition {
  return (STORE_PARTITIONS as ReadonlyArray<string>).includes(value);
}

function stampOf(path: string): string {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined ? "absent" : `${stat.size}:${stat.mtimeMs}`;
}

function parseLedger(text: string): Ledger {
  const out: Ledger = new Map();
  const parsed = JSON.parse(text) as { shards?: Record<string, unknown> };
  for (const [partition, rels] of Object.entries(parsed.shards ?? {})) {
    if (!isPartition(partition) || !Array.isArray(rels)) continue;
    out.set(partition, new Set(rels.filter((r): r is string => typeof r === "string")));
  }
  return out;
}

/** The ledger at `path`, read again only when the file changed. */
function load(path: string): Ledger {
  let stamp: string;
  try {
    stamp = stampOf(path);
  } catch {
    return new Map();
  }
  const hit = loaded.get(path);
  if (hit !== undefined && hit.stamp === stamp) return hit.ledger;
  let ledger: Ledger = new Map();
  if (stamp !== "absent") {
    try {
      ledger = parseLedger(readFileSync(path, "utf8"));
    } catch {
      // A ledger that cannot be read only loses tracking; it is rewritten.
    }
  }
  loaded.set(path, { stamp, ledger });
  return ledger;
}

/**
 * The ledger at `path`, read strictly: a file that exists but cannot be
 * read or parsed, or is not a version 1 ledger of the shape this release
 * writes, throws, so a caller that must clear the file's entries
 * (`forgetSeenPartition`) refuses instead of seeing zero entries and
 * reporting a clearing that did not happen. An absent file is zero
 * entries.
 */
function loadStrict(path: string): Ledger {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return new Map();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `the seen-shards ledger ${path} cannot be parsed ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (!isStrictLedger(parsed)) {
    throw new Error(`the seen-shards ledger ${path} is not a version 1 ledger this release reads`);
  }
  return parseLedger(text);
}

/** A version 1 ledger whose `shards` maps each partition to a list of shard names. */
function isStrictLedger(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { version, shards } = value as { version?: unknown; shards?: unknown };
  if (version !== 1) return false;
  if (typeof shards !== "object" || shards === null || Array.isArray(shards)) return false;
  return Object.entries(shards).every(
    ([partition, rels]) =>
      isPartition(partition) && Array.isArray(rels) && rels.every((rel) => typeof rel === "string"),
  );
}

/**
 * Apply `change` to the ledger on disk and write it back. The caller holds
 * the ledger lock, and `ledger` is the file as read inside it.
 */
function writeChanged(path: string, ledger: Ledger, change: (ledger: Ledger) => void): void {
  change(ledger);
  const shards: Record<string, string[]> = {};
  for (const [partition, rels] of [...ledger].toSorted(([a], [b]) => compareCodeUnits(a, b))) {
    shards[partition] = [...rels].toSorted();
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteText(path, `${JSON.stringify({ version: 1, shards }, null, 2)}\n`);
  loaded.set(path, { stamp: stampOf(path), ledger });
}

/**
 * Apply `change`, with every change of this process an earlier update
 * could not write, to the ledger on disk under the ledger lock, reading
 * the file again inside it; never throws (best-effort, see the module
 * comment).
 */
function update(path: string, change: TrackChange | null): void {
  const queued = pending.get(path) ?? [];
  if (change !== null) queued.push(change);
  // Bounded: a process that never gets the lock keeps its newest changes.
  if (queued.length > PENDING_MAX) queued.splice(0, queued.length - PENDING_MAX);
  pending.set(path, queued);
  const until = busyUntil.get(path);
  if (until !== undefined && Date.now() < until) return;
  const holder = lockHolderStamp(path);
  try {
    withLocalLock(
      path,
      () => {
        loaded.delete(path);
        // Every change an earlier update of this process could not write,
        // then this one: a skip delays a shard's tracking, it does not drop it.
        writeChanged(path, load(path), (ledger) => applyChanges(ledger, queued));
      },
      TRACK_LOCK_BUDGET_MS,
    );
    pending.delete(path);
    busyUntil.delete(path);
  } catch (err) {
    loaded.delete(path);
    // Backed off only from a lock one holder has kept the whole wait and
    // longer (a crashed process's, or one stuck). A lock that other
    // processes take and release in turn is live contention, whatever its
    // directory's stat says (on Windows a released lock directory can
    // linger with its old stat while a delete is pending), so the next
    // read tries again.
    const after = lockHolderStamp(path);
    if (
      (err as NodeJS.ErrnoException | null)?.code === "ELOCKED" &&
      holder !== null &&
      after === holder &&
      Date.now() - after >= TRACK_LOCK_BUDGET_MS
    ) {
      busyUntil.set(path, Date.now() + TRACK_BACKOFF_MS);
    }
  }
}

/** The modification time of the ledger's lock directory, or null when none is held. */
function lockHolderStamp(path: string): number | null {
  try {
    return statSync(`${path}.lock`).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The device-local ledger file of the store `storeId`, keyed by the root:
 * two copies of one store on one machine (a moved root, a test bench of two
 * machines) never share a ledger.
 */
function seenLedgerFile(storeRoot: string, storeId: string): string {
  const rootKey = createHash("sha256").update(resolve(storeRoot)).digest("hex").slice(0, 16);
  const name = SEEN_SHARDS_FILE.replace(/\.json$/, `-${rootKey}.json`);
  return join(deviceStateDirFor(storeId, processDirsEnv()), name);
}

function ledgerPath(partitionRoot: string): { path: string; partition: StorePartition } | null {
  const partition = basename(partitionRoot);
  if (!isPartition(partition)) return null;
  let storeId: string | null;
  try {
    storeId = readStoreId(partitionRoot);
  } catch {
    return null;
  }
  if (storeId === null) return null;
  return { path: seenLedgerFile(dirname(partitionRoot), storeId), partition };
}

/**
 * Remove the partition's entries from this machine's seen-shards ledger of
 * the store `storeId`, and return how many there were. Checked, not
 * best-effort: the ledger is read strictly, so a file that exists but
 * cannot be read or parsed throws (the lenient `load` would answer an
 * empty map and report a clearing that did not happen), and the write is
 * verified to have landed before the caller reports the partition cleared.
 * The read, the write and the check run under one hold of the ledger lock,
 * so a tracking update of another process lands before or after the whole
 * clearing, never inside it.
 */
export function forgetSeenPartition(
  storeRoot: string,
  storeId: string,
  partition: StorePartition,
): number {
  const path = seenLedgerFile(storeRoot, storeId);
  // This process's queued tracking of the partition goes with its entries.
  const queued = pending.get(path);
  if (queued !== undefined) {
    pending.set(
      path,
      queued.filter((change) => change.partition !== partition),
    );
  }
  return withLocalLock(path, () => {
    loaded.delete(path);
    const ledger = loadStrict(path);
    const count = ledger.get(partition)?.size ?? 0;
    if (count > 0) {
      try {
        writeChanged(path, ledger, (l) => {
          l.delete(partition);
        });
      } catch {
        loaded.delete(path);
      }
      if ((loadStrict(path).get(partition)?.size ?? 0) > 0) {
        throw new Error(
          `could not clear the seen-shard entries of the ${partition} partition in ${path}`,
        );
      }
    }
    return count;
  });
}

function deviceOf(rel: string): string {
  const parts = rel.split("/");
  return parts[parts.length - 2] ?? "";
}

function monthOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).slice(0, 7);
}

/**
 * The devices a human retired, from the `settings` shards of `shared`
 * under the store root, read raw: this runs inside stream reads.
 */
function retiredDevices(storeRoot: string): Set<string> {
  const sharedRoot = partitionDir(storeRoot, "shared");
  const records: StoreRecord[] = [];
  try {
    for (const shard of listShards(sharedRoot, { stream: "settings" })) {
      try {
        for (const r of readShard(shard.path, { partitionRoot: sharedRoot }).records) {
          if (r.bodyState !== "pending") records.push(r.record);
        }
      } catch {
        // an unreadable settings shard names no retirement
      }
    }
  } catch {
    return new Set();
  }
  return new Set(latestRetirements(records).keys());
}

/**
 * Record the shards `listed` (partition-relative paths of a listing of
 * `scope` in the partition at `partitionRoot`) as seen, and return the
 * shards of that scope this machine saw before and the listing no longer
 * finds, sorted. `replaced` names shards a compaction replaced. Answers
 * `[]` for a partition that is not held.
 */
export function trackSeenShards(
  partitionRoot: string,
  scope: SeenScope,
  listed: ReadonlyArray<string>,
  replaced: ReadonlySet<string> = new Set(),
): string[] {
  const at = ledgerPath(partitionRoot);
  if (at === null) return [];
  // What this machine has seen: the ledger, and what this process saw but
  // could not write to it yet (a queued change), so a shard tracked behind
  // a busy lock is still named once it is gone.
  const seen = new Set(load(at.path).get(at.partition) ?? []);
  for (const change of pending.get(at.path) ?? []) {
    if (change.partition !== at.partition) continue;
    for (const rel of change.fresh) seen.add(rel);
    for (const rel of change.expected) seen.delete(rel);
  }
  const present = new Set(listed);
  const fresh = listed.filter((rel) => !seen.has(rel));
  let missing = [...seen].filter(
    (rel) =>
      rel.startsWith(scope.prefix) &&
      !present.has(rel) &&
      (scope.device === undefined || deviceOf(rel) === scope.device) &&
      (scope.month === undefined || scope.month(monthOf(rel))),
  );
  let expected: string[] = missing.filter((rel) => replaced.has(rel));
  missing = missing.filter((rel) => !replaced.has(rel));
  if (missing.length > 0) {
    const retired = retiredDevices(dirname(partitionRoot));
    expected = [...expected, ...missing.filter((rel) => retired.has(deviceOf(rel)))];
    missing = missing.filter((rel) => !retired.has(deviceOf(rel)));
  }
  if (readOnlyDepth === 0) {
    if (fresh.length > 0 || expected.length > 0) {
      update(at.path, { partitionRoot, partition: at.partition, fresh, expected });
    } else if ((pending.get(at.path)?.length ?? 0) > 0) {
      // Nothing new, but changes are still queued: try to write them now.
      update(at.path, null);
    }
  }
  return missing.toSorted();
}

/** The reason a reader gives for a shard {@link trackSeenShards} reported. */
export const SEEN_SHARD_MISSING_REASON =
  "this machine read the shard before and it is gone now (the store never deletes a shard); " +
  "its records are unknown until sync delivers it again";
