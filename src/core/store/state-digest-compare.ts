/**
 * The digest roster and comparison (design D6, task 1.7). Pure: the
 * caller reads the records, this module decides what doctor reports.
 *
 *  - Roster: the devices with records in the partition during the last
 *    30 days, minus devices retired by a `device-retire` human record. A
 *    retired device that writes again after its retire record (a reused
 *    id, a machine brought back) is on the roster again.
 *  - Silent: a roster device that has published no digest in the partition
 *    for 7 days. A device first seen less than 7 days ago gets that much
 *    grace before it is reported.
 *  - Divergent: two devices whose latest digests over the SAME cut carry a
 *    different hash for a fold. Digests over different cuts are never
 *    compared, so an offline device, an idle device or a machine without
 *    a partition can neither stall the check nor raise a false alarm; it
 *    is at most reported as silent.
 *
 * Only digests from the last 7 days are compared, so a divergence that a
 * fixed release no longer produces stops being reported once its digests
 * age out.
 */

import {
  AUTHORITY_FIELD,
  DAY_MS,
  DEVICE_RETIRE_KIND,
  DIGEST_COMPARE_WINDOW_DAYS,
  DIGEST_ROSTER_WINDOW_DAYS,
  DIGEST_SILENCE_DAYS,
  STATE_DIGEST_FOLDS,
  STATE_DIGEST_KIND,
  type StateDigestFold,
  type StorePartition,
} from "./constants.ts";
import { isValidDeviceId } from "../config.ts";
import { compareRecords, type StoreRecord } from "./envelope.ts";
import { prepareRecords } from "./fold.ts";
import { parseHlc } from "./hlc.ts";
import type { DigestBody } from "./state-digest.ts";

const SHA256_RE = /^[0-9a-f]{64}$/;

const physical = (record: StoreRecord): number => parseHlc(record.hlc)!.physical;

/** A digest record whose body has the digest shape, or `null`. */
export function parseDigest(record: StoreRecord): DigestBody | null {
  if (record.kind !== STATE_DIGEST_KIND) return null;
  const body = record.body as Partial<Record<keyof DigestBody, unknown>>;
  if (typeof body.partition !== "string" || !Array.isArray(body.cut)) return null;
  if (typeof body.cut_hash !== "string" || !SHA256_RE.test(body.cut_hash)) return null;
  const folds = body.folds as Record<string, unknown> | undefined;
  if (typeof folds !== "object" || folds === null) return null;
  for (const fold of STATE_DIGEST_FOLDS) {
    if (typeof folds[fold] !== "string" || !SHA256_RE.test(folds[fold] as string)) return null;
  }
  return record.body as unknown as DigestBody;
}

export interface RosterDevice {
  readonly device: string;
  /** Physical time of its first and last record in the window. */
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
}

export interface Roster {
  readonly devices: ReadonlyArray<RosterDevice>;
  /** Devices with records in the window that a human retired. */
  readonly retired: ReadonlyArray<string>;
}

/**
 * The roster of a partition at `nowMs`. `retireRecords` are the
 * `device-retire` records to apply (they live in the `shared` partition's
 * `settings` stream, so the private partition's roster uses them too);
 * only those with `authority: "human"` count.
 */
export function computeRoster(
  partitionRecords: Iterable<StoreRecord>,
  retireRecords: Iterable<StoreRecord>,
  nowMs: number,
): Roster {
  const since = nowMs - DIGEST_ROSTER_WINDOW_DAYS * DAY_MS;
  const seen = new Map<string, { first: number; last: StoreRecord }>();
  const prepared = prepareRecords(partitionRecords);
  const all = [...prepared.records, ...prepared.pending].toSorted(compareRecords);
  for (const record of all) {
    const ms = physical(record);
    if (ms < since) continue;
    const entry = seen.get(record.device);
    if (entry === undefined) seen.set(record.device, { first: ms, last: record });
    else entry.last = record; // fold order: later records come later
  }
  const retiredAt = new Map<string, StoreRecord>();
  for (const record of prepareRecords(retireRecords).records) {
    if (record.kind !== DEVICE_RETIRE_KIND || record.body[AUTHORITY_FIELD] !== "human") continue;
    const device = record.body["device"];
    if (typeof device === "string" && isValidDeviceId(device)) retiredAt.set(device, record);
  }
  const devices: RosterDevice[] = [];
  const retired: string[] = [];
  for (const device of [...seen.keys()].toSorted()) {
    const { first, last } = seen.get(device)!;
    const retire = retiredAt.get(device);
    if (retire !== undefined && compareRecords(last, retire) < 0) {
      retired.push(device);
      continue;
    }
    devices.push({ device, firstSeenMs: first, lastSeenMs: physical(last) });
  }
  return { devices, retired };
}

export interface DivergentDevice {
  readonly device: string;
  readonly hash: string;
  /** Id of the digest record. */
  readonly digest: string;
}

export type DigestFinding =
  | {
      readonly kind: "divergent";
      readonly partition: StorePartition;
      readonly fold: StateDigestFold;
      readonly cutHash: string;
      readonly devices: ReadonlyArray<DivergentDevice>;
    }
  | {
      readonly kind: "silent";
      readonly partition: StorePartition;
      readonly device: string;
      /** Physical time of its last digest in the partition, `null` when it never published one. */
      readonly lastDigestMs: number | null;
      readonly lastRecordMs: number;
    };

export interface DigestComparison {
  readonly partition: StorePartition;
  readonly roster: Roster;
  /** Cuts that at least two devices published digests for, with those devices. */
  readonly comparedCuts: ReadonlyArray<{
    readonly cutHash: string;
    readonly devices: ReadonlyArray<string>;
  }>;
  readonly findings: ReadonlyArray<DigestFinding>;
}

export interface CompareDigestsInput {
  readonly partition: StorePartition;
  /** Every record read from the partition, digests included. */
  readonly records: ReadonlyArray<StoreRecord>;
  /** `device-retire` records (see {@link computeRoster}). */
  readonly retireRecords: ReadonlyArray<StoreRecord>;
  readonly nowMs: number;
}

/** Compare a partition's digests and report divergence and silence. */
export function compareDigests(input: CompareDigestsInput): DigestComparison {
  const { partition, nowMs } = input;
  const roster = computeRoster(input.records, input.retireRecords, nowMs);
  const digests = prepareRecords(input.records)
    .records.map((record) => ({ record, body: parseDigest(record) }))
    .filter((d): d is { record: StoreRecord; body: DigestBody } => d.body?.partition === partition);

  const lastDigest = new Map<string, number>();
  for (const { record } of digests) lastDigest.set(record.device, physical(record));

  // Latest digest per (cut, device) inside the comparison window.
  const since = nowMs - DIGEST_COMPARE_WINDOW_DAYS * DAY_MS;
  const byCut = new Map<string, Map<string, { record: StoreRecord; body: DigestBody }>>();
  for (const digest of digests) {
    if (physical(digest.record) < since) continue;
    const devices = byCut.get(digest.body.cut_hash) ?? new Map();
    devices.set(digest.record.device, digest); // fold order: the latest wins
    byCut.set(digest.body.cut_hash, devices);
  }

  const findings: DigestFinding[] = [];
  const comparedCuts: Array<{ cutHash: string; devices: string[] }> = [];
  for (const cutHash of [...byCut.keys()].toSorted()) {
    const devices = byCut.get(cutHash)!;
    if (devices.size < 2) continue;
    const names = [...devices.keys()].toSorted();
    comparedCuts.push({ cutHash, devices: names });
    for (const fold of STATE_DIGEST_FOLDS) {
      const hashes = new Set(names.map((device) => devices.get(device)!.body.folds[fold]));
      if (hashes.size < 2) continue;
      findings.push({
        kind: "divergent",
        partition,
        fold,
        cutHash,
        devices: names.map((device) => {
          const { record, body } = devices.get(device)!;
          return { device, hash: body.folds[fold], digest: record.id };
        }),
      });
    }
  }

  const silentSince = nowMs - DIGEST_SILENCE_DAYS * DAY_MS;
  for (const member of roster.devices) {
    const last = lastDigest.get(member.device) ?? null;
    if (last !== null && last >= silentSince) continue;
    if (member.firstSeenMs >= silentSince) continue; // still in its grace period
    findings.push({
      kind: "silent",
      partition,
      device: member.device,
      lastDigestMs: last,
      lastRecordMs: member.lastSeenMs,
    });
  }
  return { partition, roster, comparedCuts, findings };
}
