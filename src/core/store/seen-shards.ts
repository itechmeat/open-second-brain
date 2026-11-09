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
 * root, starts a fresh one. It is written
 * best-effort, without a lock (a reader must not take one): a lost update
 * between two processes only delays tracking a shard to the next read.
 * A surface that promises to write nothing (doctor, the status block)
 * runs inside {@link withoutSeenRecording}: it still reports a shard the
 * ledger names that is gone, and records nothing.
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

/** Apply `change` to the ledger on disk and write it back; never throws. */
function update(path: string, change: (ledger: Ledger) => void): void {
  try {
    loaded.delete(path);
    const ledger = load(path);
    change(ledger);
    const shards: Record<string, string[]> = {};
    for (const [partition, rels] of [...ledger].toSorted(([a], [b]) => compareCodeUnits(a, b))) {
      shards[partition] = [...rels].toSorted();
    }
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteText(path, `${JSON.stringify({ version: 1, shards }, null, 2)}\n`);
    loaded.set(path, { stamp: stampOf(path), ledger });
  } catch {
    // Best-effort, see the module comment.
    loaded.delete(path);
  }
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
  // Keyed by the root as well: two copies of one store on one machine (a
  // moved root, a test bench of two machines) never share a ledger.
  const rootKey = createHash("sha256")
    .update(resolve(dirname(partitionRoot)))
    .digest("hex")
    .slice(0, 16);
  const name = SEEN_SHARDS_FILE.replace(/\.json$/, `-${rootKey}.json`);
  return { path: join(deviceStateDirFor(storeId, processDirsEnv()), name), partition };
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
  const seen = load(at.path).get(at.partition) ?? new Set<string>();
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
  if (readOnlyDepth === 0 && (fresh.length > 0 || expected.length > 0)) {
    update(at.path, (ledger) => {
      const own = ledger.get(at.partition) ?? new Set<string>();
      for (const rel of fresh) own.add(rel);
      for (const rel of expected) own.delete(rel);
      ledger.set(at.partition, own);
    });
  }
  return missing.toSorted();
}

/** The reason a reader gives for a shard {@link trackSeenShards} reported. */
export const SEEN_SHARD_MISSING_REASON =
  "this machine read the shard before and it is gone now (the store never deletes a shard); " +
  "its records are unknown until sync delivers it again";
