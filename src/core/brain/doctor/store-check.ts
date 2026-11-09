/**
 * The brain store section of the doctor (design D6, task 1.11).
 *
 * Skipped silently when the store is not in use on this machine: the
 * dual-write flag is off and no store root is configured (neither the
 * `OPEN_SECOND_BRAIN_STORE_ROOT` variable nor the `store_root` config key).
 * A user who never opted in sees nothing, and the doctor's report stays
 * byte-identical to what it was before the store existed.
 *
 * When the store is in use it reports, all as warnings:
 *
 *  - dual writes that failed or were skipped (the device-local counters
 *    `store/dual-write.ts` keeps). The legacy writes were kept, so this is
 *    a gap in the trial store, not lost data;
 *  - no store at the root yet: writers never create one, so it says to run
 *    `o2b store init`;
 *  - a store root the configuration cannot use (inside the vault, or
 *    partitions of different stores);
 *  - state-digest findings (`checkStateDigests`): a fold that diverges
 *    between machines over the same cut, and roster devices that have
 *    published no digest for a week;
 *  - record ids delivered with different content (`prepareRecords`), which
 *    is tampering or a writer bug;
 *  - records whose clock is more than the drift bound (`HLC_MAX_DRIFT_MS`)
 *    ahead of now, per device with the newest stamp. They are still folded
 *    and win "later clock" ties, so a broken clock on one machine shows up
 *    here instead of silently outvoting the others;
 *  - a held partition that cannot be read (the others are still checked),
 *    and a shard that cannot be read, by its path: the partition's other
 *    shards are still checked, but its digests are not compared (a cut
 *    missing a shard would read as a false divergence), and when the
 *    shard is in `shared` no partition reports silent devices, because
 *    the device retirements may be in it;
 *  - a shard whose last bytes have not verified for an hour: the reader
 *    holds that tail back, so the record in it is read nowhere;
 *  - what a synced peer can deliver (`store-trust-check.ts`): a record id
 *    in both partitions, and store paths other local accounts can read.
 *
 * Read-only: it never creates the store or refreshes its format document.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { STORE_PARTITIONS, type StorePartition } from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { compareHlc, formatHlc, HLC_MAX_DRIFT_MS, parseHlc, type Hlc } from "../../store/hlc.ts";
import { compareCodeUnits } from "../../store/compare.ts";
import { isDualWriteEnabled, readDualWriteStatus } from "../../store/dual-write.ts";
import { prepareRecords } from "../../store/fold.ts";
import { checkStateDigests } from "../../store/state-digest-check.ts";
import type { DigestFinding } from "../../store/state-digest-compare.ts";
import {
  readPartition,
  type PartitionShard,
  type UnreadableShard,
} from "../../store/state-digest.ts";
import {
  HeldPartitionLostError,
  inspectStore,
  type StoreInspection,
} from "../../store/store-open.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { removalBacklog } from "../../store/removal-backlog.ts";
import { readStoreWriteStatus, storeWriteStatusPath } from "../../store/store-write.ts";
import {
  dualWriteStatusPath,
  isPathInsideResolved,
  partitionDir,
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
  type ResolvedStoreRoot,
} from "../../store/store-paths.ts";
import type { DoctorIssue } from "../types.ts";
import {
  crossPartitionIdIssues,
  looseModeIssues,
  reservedDeviceDirIssues,
} from "./store-trust-check.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";
import { returnedRetiredIssues } from "./device-retire-check.ts";

/** Removed content still awaits compaction in the shards. */
export const STORE_REMOVED_AWAITING_COMPACTION_CODE = "store-removed-awaiting-compaction";
/** Dual writes failed; the legacy writes were kept. */
export const STORE_DUAL_WRITE_FAILURES_CODE = "store-dual-write-failures";
/** Dual writes were skipped because this machine has no device id. */
export const STORE_DUAL_WRITE_SKIPPED_CODE = "store-dual-write-skipped";
/** The configured store root cannot be used. */
export const STORE_ROOT_INVALID_CODE = "store-root-invalid";
/**
 * A partition this machine has held lost its identity file, so the store is
 * not opened and every protection fails closed (design D14).
 */
export const STORE_PARTITION_LOST_CODE = "store-partition-lost";
/** A fold differs between machines over the same cut. */
export const STORE_DIGEST_DIVERGENT_CODE = "store-digest-divergent";
/** A roster device has published no state digest for a week. */
export const STORE_DIGEST_SILENT_CODE = "store-digest-silent";
/** One record id was delivered with different content. */
export const STORE_RECORD_ID_CONFLICT_CODE = "store-record-id-conflict";
/** A partition this machine holds could not be read. */
export const STORE_PARTITION_UNREADABLE_CODE = "store-partition-unreadable";
/** One shard of a held partition could not be read; the rest were checked. */
export const STORE_SHARD_UNREADABLE_CODE = "store-shard-unreadable";
/** A shard's last bytes have not verified for a long time, so its last record is read nowhere. */
export const STORE_SHARD_TAIL_HELD_CODE = "store-shard-tail-held";
/** No store exists at the root; `o2b store init` creates one. */
export const STORE_MISSING_CODE = "store-missing";
/** Dual writes were skipped because no store existed. */
export const STORE_DUAL_WRITE_NO_STORE_CODE = "store-dual-write-no-store";
/**
 * Fail-open store-only writes (hooks, telemetry) that did not land: the
 * caller went on, so the store is missing those records (design D14 item 1).
 */
export const STORE_WRITE_FAIL_OPEN_CODE = "store-write-fail-open";
/** Records carry a clock more than the drift bound ahead of now. */
export const STORE_CLOCK_AHEAD_CODE = "store-clock-ahead";

/** Age after which a held-back shard tail is no longer an append or a sync in progress. */
export const HELD_TAIL_STALE_MS = 60 * 60 * 1000;

/** Conflicting ids named in one finding before the rest are only counted. */
const CONFLICT_SAMPLE = 5;

function warn(out: DoctorFindings, code: string, message: string, path?: string): void {
  out.issues.push({
    severity: "warning",
    code,
    ...(path !== undefined ? { path } : {}),
    message,
  } satisfies DoctorIssue);
}

function dualWriteFindings(out: DoctorFindings): void {
  const path = dualWriteStatusPath();
  const status = readDualWriteStatus(path);
  if (status.failures > 0) {
    warn(
      out,
      STORE_DUAL_WRITE_FAILURES_CODE,
      `${status.failures} brain store dual write(s) failed on this machine` +
        (status.last_failure_at !== null ? `, the last at ${status.last_failure_at}` : "") +
        (status.last_error !== null ? ` (${status.last_error})` : "") +
        "; the legacy writes were kept, so the store is missing those records. " +
        "Fix the cause, then delete the counter file to reset it",
      path,
    );
  }
  if (status.skipped_no_device > 0) {
    warn(
      out,
      STORE_DUAL_WRITE_SKIPPED_CODE,
      `${status.skipped_no_device} brain store dual write(s) were skipped because this machine ` +
        "has no device id; set device_id in the machine config (and leave O2B_DEVICE_ID unset " +
        "or set it to a real id) so the store can name this device's shards",
      path,
    );
  }
  if (status.skipped_no_store > 0) {
    warn(
      out,
      STORE_DUAL_WRITE_NO_STORE_CODE,
      `${status.skipped_no_store} brain store dual write(s) were skipped because no store ` +
        "existed; the legacy writes were kept, so the store is missing those records. " +
        "Run `o2b store init` if it has not been run, then delete the counter file to reset it",
      path,
    );
  }
}

function failOpenWriteFindings(out: DoctorFindings): void {
  const path = storeWriteStatusPath();
  const status = readStoreWriteStatus(path);
  if (status.failures === 0) return;
  warn(
    out,
    STORE_WRITE_FAIL_OPEN_CODE,
    `${status.failures} fail-open brain store write(s) on this machine did not land` +
      (status.last_failure_at !== null ? `, the last at ${status.last_failure_at}` : "") +
      (status.last_error !== null ? ` (${status.last_error})` : "") +
      "; the hooks and telemetry that made them went on, so the store is missing those " +
      "records. Fix the cause, then delete the counter file to reset it",
    path,
  );
}

/** Records more than the drift bound ahead of `nowMs`, per device: count and newest stamp. */
function clockAheadByDevice(
  records: ReadonlyArray<StoreRecord>,
  nowMs: number,
): Map<string, { count: number; newest: Hlc }> {
  const out = new Map<string, { count: number; newest: Hlc }>();
  for (const record of records) {
    const stamp = parseHlc(record.hlc);
    if (stamp === null || stamp.physical - nowMs <= HLC_MAX_DRIFT_MS) continue;
    const seen = out.get(record.device);
    if (seen === undefined) out.set(record.device, { count: 1, newest: stamp });
    else {
      seen.count += 1;
      if (compareHlc(stamp, seen.newest) > 0) seen.newest = stamp;
    }
  }
  return out;
}

function clockAheadFinding(
  out: DoctorFindings,
  partition: string,
  path: string,
  ahead: Map<string, { count: number; newest: Hlc }>,
): void {
  if (ahead.size === 0) return;
  const total = [...ahead.values()].reduce((sum, d) => sum + d.count, 0);
  const devices = [...ahead]
    .toSorted(([a], [b]) => compareCodeUnits(a, b))
    .map(
      ([device, d]) =>
        `${device} (${d.count}, newest ${formatHlc(d.newest)} = ` +
        `${new Date(d.newest.physical).toISOString()})`,
    )
    .join(", ");
  warn(
    out,
    STORE_CLOCK_AHEAD_CODE,
    `${total} record(s) in the ${partition} partition carry a clock more than ` +
      `${HLC_MAX_DRIFT_MS / 3_600_000} hours ahead of now: ${devices}. They are still folded and ` +
      "win ties on the later clock; fix the clock of the named device",
    path,
  );
}

function digestMessage(finding: DigestFinding): string {
  if (finding.kind === "divergent") {
    const devices = finding.devices.map((d) => `${d.device} (${d.hash.slice(0, 12)})`).join(", ");
    return (
      `the ${finding.fold} fold of the ${finding.partition} partition differs between devices ` +
      `that read the same records (cut ${finding.cutHash.slice(0, 12)}): ${devices}. ` +
      "Two machines computed different state from identical input, which is a fold bug; " +
      "keep both machines' store folders as they are and report it"
    );
  }
  const last =
    finding.lastDigestMs === null
      ? "has never published one"
      : `last published one at ${new Date(finding.lastDigestMs).toISOString()}`;
  return (
    `device ${finding.device} has written to the ${finding.partition} partition but ${last}; ` +
    "its state cannot be compared until it catches up. If the machine is gone for good, " +
    `retire it with \`o2b store device retire ${finding.device}\``
  );
}

/**
 * Read every partition this machine holds, once, for every check below. A
 * shard that cannot be read is reported by its path and left out; the
 * other shards are still checked. Returns the shards read and the
 * partitions read in full.
 */
function readHeldPartitions(
  store: StoreInspection,
  out: DoctorFindings,
): { shards: Map<StorePartition, PartitionShard[]>; complete: Set<StorePartition> } {
  const shards = new Map<StorePartition, PartitionShard[]>();
  const complete = new Set<StorePartition>();
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    const dir = partitionDir(store.root, partition);
    // In `shared` the device retirements live, which every partition's
    // roster applies: without them a retired device would read as silent.
    const retirements =
      partition === "shared"
        ? "; device retirements could not all be read, so no partition reports silent devices"
        : "";
    const unreadable: UnreadableShard[] = [];
    try {
      // A shard read only in part is still in the read and its cut, so the
      // digests compare; the gap itself is not this check's finding.
      shards.set(
        partition,
        readPartition(dir, {
          onUnreadable: (s) => {
            if (s.incomplete !== true) unreadable.push(s);
          },
        }),
      );
    } catch (err) {
      warn(
        out,
        STORE_PARTITION_UNREADABLE_CODE,
        `the ${partition} partition could not be read (` +
          (err instanceof Error ? err.message : String(err)) +
          `); its digests and record ids were not checked${retirements}`,
        dir,
      );
      continue;
    }
    for (const shard of unreadable) {
      warn(
        out,
        STORE_SHARD_UNREADABLE_CODE,
        `the shard ${shard.rel} in the ${partition} partition could not be read (` +
          (shard.error instanceof Error ? shard.error.message : String(shard.error)) +
          "), for example while a sync client holds it; the partition's digests were not " +
          `compared, and its other shards were still checked${retirements}`,
        shard.path,
      );
    }
    if (unreadable.length === 0) complete.add(partition);
  }
  return { shards, complete };
}

/**
 * Shards whose last bytes have not verified for {@link HELD_TAIL_STALE_MS}:
 * the reader holds such a tail back, so the record in it reaches no index
 * and no fold on any machine. A tail still being written or synced is
 * younger than that.
 */
function heldTailFindings(
  store: StoreInspection,
  shards: ReadonlyMap<StorePartition, ReadonlyArray<PartitionShard>>,
  nowMs: number,
  out: DoctorFindings,
): void {
  for (const [partition, own] of shards) {
    for (const shard of own) {
      if (shard.heldTailBytes === 0) continue;
      const path = join(partitionDir(store.root, partition), ...shard.rel.split("/"));
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue; // gone since the read: nothing held any more
      }
      if (nowMs - mtimeMs < HELD_TAIL_STALE_MS) continue;
      warn(
        out,
        STORE_SHARD_TAIL_HELD_CODE,
        `the last ${shard.heldTailBytes} byte(s) of the shard ${shard.rel} in the ${partition} ` +
          `partition have not verified since ${new Date(mtimeMs).toISOString()}, so no machine ` +
          "reads the record there. A crash in the middle of an append or a damaged sync copy " +
          `leaves such a tail; the next append by device ${shard.device} starts on a new line, ` +
          "and the tail is then counted as a corrupt line",
        path,
      );
    }
  }
}

function storeFindings(
  store: StoreInspection,
  ctx: StoreSideCheckContext,
  out: DoctorFindings,
): void {
  const nowMs = ctx.now.getTime();
  const { shards, complete } = readHeldPartitions(store, out);
  // Digests are compared only over partitions read in full: a cut with a
  // shard missing would read as a divergence that is not there.
  const digestShards = new Map([...shards].filter(([partition]) => complete.has(partition)));
  const retirementsKnown = !store.partitions.has("shared") || complete.has("shared");
  const report = checkStateDigests(store, { now: () => nowMs, shards: digestShards });
  for (const finding of report.findings) {
    if (finding.kind === "silent" && !retirementsKnown) continue;
    warn(
      out,
      finding.kind === "divergent" ? STORE_DIGEST_DIVERGENT_CODE : STORE_DIGEST_SILENT_CODE,
      digestMessage(finding),
      partitionDir(store.root, finding.partition),
    );
  }
  heldTailFindings(store, shards, nowMs, out);
  if (retirementsKnown) {
    out.issues.push(...returnedRetiredIssues(digestShards, partitionDir(store.root, "shared")));
  }
  removalBacklogFinding(store, shards, out);
  out.issues.push(...crossPartitionIdIssues(store, shards));
  out.issues.push(...looseModeIssues(store));
  out.issues.push(...reservedDeviceDirIssues(store));
  for (const [partition, own] of shards) {
    const records = own.flatMap((s) => s.all);
    clockAheadFinding(
      out,
      partition,
      partitionDir(store.root, partition),
      clockAheadByDevice(records, nowMs),
    );
    const { conflicts } = prepareRecords(records);
    if (conflicts.length === 0) continue;
    const sample = conflicts
      .slice(0, CONFLICT_SAMPLE)
      .map((c) => `${c.id} (${c.versions} versions)`)
      .join(", ");
    const more =
      conflicts.length > CONFLICT_SAMPLE ? ` and ${conflicts.length - CONFLICT_SAMPLE} more` : "";
    warn(
      out,
      STORE_RECORD_ID_CONFLICT_CODE,
      `${conflicts.length} record id(s) in the ${partition} partition were delivered with ` +
        `different content: ${sample}${more}. Every machine keeps the same version, but a record ` +
        "should never change after it is written: look for an edited shard file or a writer bug",
      partitionDir(store.root, partition),
    );
  }
}

/**
 * Removed content the shards still hold (FORMAT.md, "Removal"): a
 * tombstone takes a signal, a preference or a lane entry out of every
 * read, but the earlier lines stay in the append-only shards, here and on
 * every machine they sync to, until store compaction exists. Reported so
 * a user who asked to forget knows the bytes are not gone yet.
 */
function removalBacklogFinding(
  store: StoreInspection,
  shards: ReadonlyMap<StorePartition, ReadonlyArray<PartitionShard>>,
  out: DoctorFindings,
): void {
  const records = [...shards.values()].flatMap((own) => own.flatMap((s) => s.all));
  const backlog = removalBacklog(records);
  if (backlog.total === 0) return;
  warn(
    out,
    STORE_REMOVED_AWAITING_COMPACTION_CODE,
    `${backlog.total} record(s) of removed content still sit in the store's shards ` +
      `(${backlog.signals} of forgotten signals, ${backlog.preferences} of removed preferences, ` +
      `${backlog.laneEntries} of removed lane entries). No read shows them, but the append-only ` +
      "shards keep the original lines, on this machine and on every machine they sync to, " +
      "until store compaction exists",
    store.root,
  );
}

/** Whether this machine uses the store: the flag is on or a root is configured. */
function storeInUse(
  ctx: StoreSideCheckContext,
  root: ResolvedStoreRoot | null,
  rootError: unknown,
): boolean {
  if (isDualWriteEnabled(ctx.configPath)) return true;
  // A store-only machine (switched, or a fresh install at the default
  // root with no dual write) depends on the store for everything.
  const context = {
    vault: ctx.vault,
    ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
  };
  if (root !== null && isStoreOnly(context)) return true;
  if (root !== null) return root.origin !== "default";
  // The resolver refused the root: in use only when the user configured one.
  return rootError instanceof StoreRootInsideVaultError && rootError.origin !== "default";
}

export const storeCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    let root: ResolvedStoreRoot | null = null;
    let rootError: unknown = null;
    try {
      root = resolveConfiguredStoreRoot(ctx.configPath);
      // The vault this pass checks may not be the configured one; a root
      // inside it is just as wrong.
      if (ctx.vault !== null && isPathInsideResolved(root.root, ctx.vault, process.platform)) {
        rootError = new StoreRootInsideVaultError(root.root, ctx.vault, root.origin);
      }
    } catch (err) {
      rootError = err;
    }
    if (!storeInUse(ctx, root, rootError)) return;

    dualWriteFindings(out);
    failOpenWriteFindings(out);
    if (rootError !== null || root === null) {
      warn(
        out,
        STORE_ROOT_INVALID_CODE,
        rootError instanceof Error ? rootError.message : String(rootError),
      );
      return;
    }
    let store: StoreInspection | null;
    try {
      store = inspectStore(root.root);
    } catch (err) {
      if (err instanceof HeldPartitionLostError) {
        out.issues.push({
          severity: "error",
          code: STORE_PARTITION_LOST_CODE,
          path: root.root,
          message: err.message,
        } satisfies DoctorIssue);
        return;
      }
      warn(
        out,
        STORE_ROOT_INVALID_CODE,
        err instanceof Error ? err.message : String(err),
        root.root,
      );
      return;
    }
    if (store === null) {
      // With dual writes off nothing is skipped, so a root that holds no
      // store yet is not a finding (a configured root may be prepared
      // before the flag is turned on).
      if (!isDualWriteEnabled(ctx.configPath)) return;
      warn(
        out,
        STORE_MISSING_CODE,
        `there is no brain store at ${root.root} yet, so dual writes are skipped. Run ` +
          "`o2b store init` on the first machine (`--partitions shared` on a machine that must " +
          "not hold private records); other machines receive the partitions through sync",
        root.root,
      );
      return;
    }
    storeFindings(store, ctx, out);
  },
};
