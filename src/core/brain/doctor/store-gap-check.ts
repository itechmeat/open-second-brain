/**
 * The doctor's findings for a shard read only in part (change
 * store-hardening, design D5; spec `store-shard-gaps`).
 *
 * A held shard with a gap fails every protection read closed on this
 * machine. For each such shard (the ones the partition read reports with
 * `incomplete`), the shard is read again and one finding is reported per
 * gap, path `<partition>/<shard>`:
 *
 *  - `store-shard-corrupt-line`, error: a bad line in the middle, with the
 *    offset, what fails closed, and the command that quarantines it on this
 *    machine;
 *  - `store-shard-line-too-long`, error: a bad line that runs past the
 *    quarantine hash cap (the probe `probeLineHashAt` answers `too-long`),
 *    so the quarantine command would always refuse: no command is named,
 *    only repair at the line's source;
 *  - `store-shard-newer-format`, warning: a record of a format this release
 *    does not know; upgrading reads it, so no quarantine is offered;
 *  - `store-shard-blob-pending`, warning while the record is younger than
 *    {@link PENDING_BLOB_QUARANTINE_AGE_MS} (a sync tool may still deliver
 *    the blob), error from then on, with the quarantine command once it is
 *    allowed and never for a `settings` shard; an error with no command when
 *    the record's clock stamp does not parse as a time (its age is unknown,
 *    and the current time is never put in its place).
 *
 * A line torn by a crash and closed by the next append, and a line this
 * machine quarantined, are no gap and give no finding. A shard removed
 * since the partition read (`ENOENT` on the second read) is skipped: no gap
 * is left. Any other failure of the second read (a lock, a permission, a
 * link) is a `store-shard-unreadable` error naming the shard and the error
 * code. Any other diagnostic (a shard swapped for a link, an offset past
 * its end) is a `store-shard-unreadable` error too, a code whose next step
 * names no command, since a quarantine cannot release it.
 *
 * Below local reach the store check hands this module no shard of the
 * `private` partition (`store-check.ts`, `storeAtReach`): its path,
 * offsets and record times are private metadata, and a remote caller's
 * `ok`, counts and trust verdict read as if the gap were not there.
 */

import { join } from "node:path";

import type { StorePartition } from "../../store/constants.ts";
import { readShard } from "../../store/reader.ts";
import {
  PENDING_BLOB_QUARANTINE_AGE_MS,
  PENDING_BLOB_QUARANTINE_AGE_TEXT,
  pendingRecordWrittenMs,
  probeLineHashAt,
} from "../../store/shard-quarantine.ts";
import { partitionDir } from "../../store/store-paths.ts";
import type { StoreInspection } from "../../store/store-open.ts";
import type { DoctorIssue } from "../types.ts";
import type { DoctorFindings } from "./check.ts";

/** One shard of a held partition could not be read; the rest were checked. */
export const STORE_SHARD_UNREADABLE_CODE = "store-shard-unreadable";
/** A bad line in the middle of a held shard. */
export const STORE_SHARD_CORRUPT_LINE_CODE = "store-shard-corrupt-line";
/** A record of a newer format in a held shard. */
export const STORE_SHARD_NEWER_FORMAT_CODE = "store-shard-newer-format";
/** A record whose body blob has not arrived. */
export const STORE_SHARD_BLOB_PENDING_CODE = "store-shard-blob-pending";
/**
 * A bad line too long to hash (past `QUARANTINE_HASH_CAP_BYTES`): no
 * quarantine can name it, so the code registers no quarantine command.
 */
export const STORE_SHARD_LINE_TOO_LONG_CODE = "store-shard-line-too-long";

/** The error code of a failed read, or the error's name when it carries none. */
function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    if (err instanceof Error) return err.name;
  }
  return String(err);
}

/** A held shard the partition read reported as read only in part. */
export interface PartialShard {
  readonly partition: StorePartition;
  /** Partition-relative path, `/`-separated. */
  readonly rel: string;
}

const FAILS_CLOSED =
  "Until it is resolved, every read that decides a protection fails closed on this machine: " +
  "capture, settings reads and writes, lane privacy, exact state, attestations, the OKF " +
  "export and the migration";

const quarantineCommand = (shard: string, offset: number): string =>
  `o2b store shard quarantine ${shard} --offset ${offset}`;

/** What to do about a pending blob of the given age and shard. */
function pendingRemedy(old: boolean, settings: boolean, shard: string, offset: number): string {
  if (!old) {
    return (
      "A sync tool may still deliver it; it is not quarantined before it is " +
      `${PENDING_BLOB_QUARANTINE_AGE_TEXT} old`
    );
  }
  if (settings) {
    return "A settings record is never quarantined: deliver the blob from the machine that wrote it";
  }
  return `When the blob is lost, skip the record on this machine with \`${quarantineCommand(shard, offset)}\``;
}

/**
 * Report one finding per gap of each of `partial`'s shards. Below local
 * reach the caller passes no shard of the `private` partition
 * (`store-check.ts`, `storeAtReach`).
 */
export function storeGapFindings(
  store: StoreInspection,
  partial: ReadonlyArray<PartialShard>,
  nowMs: number,
  out: DoctorFindings,
): void {
  for (const { partition, rel } of partial) {
    const partitionRoot = partitionDir(store.root, partition);
    const shard = `${partition}/${rel}`;
    const shardPath = join(partitionRoot, ...rel.split("/"));
    let read: ReturnType<typeof readShard>;
    try {
      read = readShard(shardPath, { partitionRoot });
    } catch (err) {
      // Removed since the partition read: there is no gap left to name.
      if (errorCode(err) === "ENOENT") continue;
      out.issues.push({
        severity: "error",
        code: STORE_SHARD_UNREADABLE_CODE,
        path: shard,
        message:
          `the shard ${shard}, read only in part, could not be read again (${errorCode(err)}), ` +
          `for example while a sync client holds it, so its gaps are not named here. ${FAILS_CLOSED}`,
      } satisfies DoctorIssue);
      continue;
    }
    for (const d of read.diagnostics) {
      if (d.torn === true || d.quarantined === true) continue;
      if (d.kind === "unknown-version") {
        out.issues.push({
          severity: "warning",
          code: STORE_SHARD_NEWER_FORMAT_CODE,
          path: shard,
          message:
            `the record at byte ${d.offset} of the shard ${shard} is of a newer format ` +
            `(${d.reason}); upgrade Open Second Brain on this machine to read it. ${FAILS_CLOSED}`,
        } satisfies DoctorIssue);
        continue;
      }
      if (d.kind !== "corrupt-line") {
        // A shard swapped for a link, or cut below the offset, since the
        // partition read: no line a quarantine could release, so the code
        // is one whose next step names no quarantine command.
        out.issues.push({
          severity: "error",
          code: STORE_SHARD_UNREADABLE_CODE,
          path: shard,
          message:
            `the shard ${shard} could not be read from byte ${d.offset} (${d.reason}). ` +
            `${FAILS_CLOSED}`,
        } satisfies DoctorIssue);
        continue;
      }
      const probe = probeLineHashAt(shardPath, d.offset, partitionRoot);
      if ("failure" in probe && probe.failure === "too-long") {
        // The verb hashes the line before it records it and refuses one past
        // the hash cap (`line-too-long`): naming it would be a dead end.
        out.issues.push({
          severity: "error",
          code: STORE_SHARD_LINE_TOO_LONG_CODE,
          path: shard,
          message:
            `the line at byte ${d.offset} of the shard ${shard} is not a valid record ` +
            `(${d.reason}). ${FAILS_CLOSED}. The line runs past the longest line a quarantine ` +
            "can name, so it cannot be skipped on this machine: repair or remove it at its " +
            "source, in the shard of the device that wrote it",
        } satisfies DoctorIssue);
        continue;
      }
      out.issues.push({
        severity: "error",
        code: STORE_SHARD_CORRUPT_LINE_CODE,
        path: shard,
        message:
          `the line at byte ${d.offset} of the shard ${shard} is not a valid record ` +
          `(${d.reason}). ${FAILS_CLOSED}. When the line cannot be repaired at its source, ` +
          `skip it on this machine with \`${quarantineCommand(shard, d.offset)}\``,
      } satisfies DoctorIssue);
    }
    const settings = rel.split("/")[0] === "settings";
    for (const r of read.records) {
      if (r.bodyState !== "pending" || r.quarantined === true) continue;
      const written = pendingRecordWrittenMs(r.record.hlc);
      if (written === null) {
        out.issues.push({
          severity: "error",
          code: STORE_SHARD_BLOB_PENDING_CODE,
          path: shard,
          message:
            `the record at byte ${r.offset} of the shard ${shard} has a body blob that has not ` +
            `arrived, and its clock stamp does not parse as a time, so its age is unknown. ` +
            `${FAILS_CLOSED}. It is never quarantined by age: deliver the blob, or repair the ` +
            "record, from the machine that wrote it",
        } satisfies DoctorIssue);
        continue;
      }
      const old = nowMs - written >= PENDING_BLOB_QUARANTINE_AGE_MS;
      const remedy = pendingRemedy(old, settings, shard, r.offset);
      out.issues.push({
        severity: old ? "error" : "warning",
        code: STORE_SHARD_BLOB_PENDING_CODE,
        path: shard,
        message:
          `the record at byte ${r.offset} of the shard ${shard} has a body blob that has not ` +
          `arrived since ${new Date(written).toISOString()}. ${FAILS_CLOSED}. ${remedy}`,
      } satisfies DoctorIssue);
    }
  }
}
