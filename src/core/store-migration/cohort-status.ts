/**
 * The state of each migration cohort device (change
 * stale-device-retirement, design D5-D7), as the removal, the doctor and
 * the store status block report it:
 *
 *  - `switched`: its own human `device-switched` record stands;
 *  - `retired`: a human `device-retire` record took it out of the cohort;
 *  - `silent`: retired by silence (`device-silence.ts`), its last evidence
 *    older than `migration.silent_device_days`;
 *  - `pending`: still on the legacy layout, holding the tree in the vault.
 *
 * The members are the cohort record's devices, the devices the legacy
 * per-device shards name, and the devices the caller counts as still on
 * the legacy layout. Derived on every read and never recorded, so a device
 * that writes again is pending again at once.
 */

import type { StoreHandle } from "../store/store-open.ts";
import { compareCodeUnits } from "../store/compare.ts";
import { legacyDeviceEvidence, storeDeviceEvidence } from "./device-evidence.ts";
import { judgeSilence } from "./device-silence.ts";
import {
  cohortFirstSeen,
  legacyDevices,
  silenceThresholdDays,
  switchedDeviceIds,
} from "./migration-records.ts";

export type CohortDeviceState = "switched" | "retired" | "silent" | "pending";

export interface CohortDevice {
  readonly device: string;
  readonly state: CohortDeviceState;
  /** ISO time of the device's last evidence of life, or null when it left none. */
  readonly last_evidence: string | null;
}

export interface DeviceEvidenceDate {
  readonly device: string;
  readonly last_evidence: string | null;
}

export interface CohortStatus {
  /** `migration.silent_device_days`; 0 means the rule is off. */
  readonly threshold_days: number;
  /** The reference the ages were measured against (ISO), or null with no evidence anywhere. */
  readonly as_of: string | null;
  /** Every cohort device, sorted by id. */
  readonly devices: ReadonlyArray<CohortDevice>;
  /**
   * Every device with a standing `device-switched` record, the cohort's and
   * a later machine's alike (a device that migrated after the cohort record
   * was written is no cohort member, and switched all the same).
   */
  readonly switched: ReadonlyArray<string>;
  /** Cohort devices a human `device-retire` record took out of the cohort. */
  readonly retired: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<DeviceEvidenceDate>;
  readonly retired_by_silence: ReadonlyArray<DeviceEvidenceDate>;
  /** Nothing is pending: the legacy tree may leave the vault. */
  readonly can_leave: boolean;
}

export interface CohortInput {
  /** Devices still on the legacy layout before the silence rule (`legacyDevices`). */
  readonly legacy: ReadonlyArray<string>;
  /** Device ids the legacy shards name, with their newest dated trace. */
  readonly legacyEvidence: ReadonlyMap<string, number | null>;
  readonly now: Date;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The cohort status from what the caller already read (the removal's import). */
export function cohortStatus(
  store: Pick<StoreHandle, "root" | "partitions">,
  input: CohortInput,
): CohortStatus {
  const firstSeen = cohortFirstSeen(store);
  const switched = switchedDeviceIds(store);
  const stored = storeDeviceEvidence(store);
  const legacy = new Set(input.legacy);
  const members = new Set([...firstSeen.keys(), ...input.legacyEvidence.keys(), ...legacy]);
  const evidenceOf = (device: string): number | null => {
    const values = [input.legacyEvidence.get(device) ?? null, stored.get(device) ?? null].filter(
      (v): v is number => v !== null,
    );
    return values.length > 0 ? Math.max(...values) : null;
  };
  const judged = [...legacy].map((device) => ({
    device,
    evidenceMs: evidenceOf(device),
    cohortMs: firstSeen.get(device) ?? null,
  }));
  const others = [...new Set([...members, ...stored.keys()])]
    .filter((d) => !legacy.has(d))
    .map(evidenceOf)
    .filter((v): v is number => v !== null);
  const judgement = judgeSilence({
    devices: judged,
    otherEvidenceMs: others,
    wallMs: input.now.getTime(),
    thresholdDays: silenceThresholdDays(store),
  });
  const verdicts = new Map(judgement.verdicts.map((v) => [v.device, v]));
  const devices = [...members].toSorted(compareCodeUnits).map((device): CohortDevice => {
    const verdict = verdicts.get(device);
    if (verdict !== undefined) {
      return {
        device,
        state: verdict.silent ? "silent" : "pending",
        last_evidence: iso(verdict.lastEvidenceMs),
      };
    }
    return {
      device,
      state: switched.has(device) ? "switched" : "retired",
      last_evidence: iso(evidenceOf(device)),
    };
  });
  const dated = (state: CohortDeviceState): DeviceEvidenceDate[] =>
    devices
      .filter((d) => d.state === state)
      .map((d) => ({ device: d.device, last_evidence: d.last_evidence }));
  const pending = dated("pending");
  return {
    threshold_days: judgement.thresholdDays,
    as_of: iso(judgement.referenceMs),
    devices,
    switched: [
      ...new Set([
        ...devices.filter((d) => d.state === "switched").map((d) => d.device),
        ...[...switched].filter((d) => !legacy.has(d)),
      ]),
    ].toSorted(compareCodeUnits),
    retired: devices.filter((d) => d.state === "retired").map((d) => d.device),
    pending,
    retired_by_silence: dated("silent"),
    can_leave: pending.length === 0,
  };
}

/** The cohort status of `vault` read afresh (the doctor and the status block). */
export function readCohortStatus(
  store: Pick<StoreHandle, "root" | "partitions">,
  vault: string,
  now: Date,
): CohortStatus {
  const legacyEvidence = legacyDeviceEvidence(vault);
  return cohortStatus(store, {
    legacy: legacyDevices(store as StoreHandle, [...legacyEvidence.keys()]),
    legacyEvidence,
    now,
  });
}
