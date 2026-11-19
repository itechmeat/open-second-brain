/**
 * The "retired by silence" rule (change stale-device-retirement, design
 * D1-D3): a cohort device that has not switched counts as retired once its
 * last evidence of life is older than the threshold every machine of the
 * store agrees on (`migration.silent_device_days`). Pure: the evidence is
 * read elsewhere (`device-evidence.ts`), so one table test covers the rule.
 *
 *  - The last evidence of a device is the newest dated trace it left (a
 *    legacy shard name date, a row time, a store record clock); a device
 *    with none takes the clock of the earliest cohort record naming it, and
 *    a device with neither is never retired by silence.
 *  - The reference is the newest evidence of any device (this machine's own
 *    records included) that is not later than this machine's wall clock;
 *    evidence in the future is ignored for the reference, not clamped to
 *    the clock, so judging stays relative to what this machine has seen.
 *    A wrong clock is bounded by the dates actually written: a peer
 *    stamping the future changes no other device's verdict, a clock
 *    behind retires fewer devices, and a clock ahead here changes nothing
 *    until this machine writes under it.
 *  - Evidence later than the reference counts as the reference.
 *  - A device is silent when reference - last evidence is greater than the
 *    threshold; a threshold of 0 turns the rule off.
 *
 * Nothing here is recorded: every caller derives the answer from what it
 * reads, so a device that writes again is pending again at once.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** One device the rule judges (a cohort device that has not switched). */
export interface DeviceEvidenceInput {
  readonly device: string;
  /** Newest dated trace of the device, in ms, or null when it left none. */
  readonly evidenceMs: number | null;
  /** Clock of the earliest cohort record naming the device, in ms, or null. */
  readonly cohortMs: number | null;
}

export interface SilenceInput {
  readonly devices: ReadonlyArray<DeviceEvidenceInput>;
  /** Evidence of the devices not judged (switched devices, this machine), for the reference. */
  readonly otherEvidenceMs: ReadonlyArray<number>;
  /** This machine's wall clock, in ms. */
  readonly wallMs: number;
  /** The threshold in days; 0 turns the rule off. */
  readonly thresholdDays: number;
}

export interface SilenceVerdict {
  readonly device: string;
  /** The last evidence the rule measured (the cohort record's clock when no trace), or null. */
  readonly lastEvidenceMs: number | null;
  readonly silent: boolean;
}

export interface SilenceJudgement {
  /** The time ages are measured against, or null when no device left any evidence. */
  readonly referenceMs: number | null;
  readonly thresholdDays: number;
  /** One verdict per judged device, sorted by device id. */
  readonly verdicts: ReadonlyArray<SilenceVerdict>;
}

/** Judge every device of `input` (see the module header). */
export function judgeSilence(input: SilenceInput): SilenceJudgement {
  const all = [
    ...input.otherEvidenceMs,
    ...input.devices.flatMap((d) => (d.evidenceMs === null ? [] : [d.evidenceMs])),
  ].filter((ms) => Number.isFinite(ms) && ms <= input.wallMs);
  const referenceMs = all.length > 0 ? Math.max(...all) : null;
  const limitMs = input.thresholdDays * DAY_MS;
  const verdicts = input.devices
    .map((d): SilenceVerdict => {
      const last = d.evidenceMs ?? d.cohortMs;
      const silent =
        input.thresholdDays > 0 &&
        referenceMs !== null &&
        last !== null &&
        referenceMs - Math.min(last, referenceMs) > limitMs;
      return { device: d.device, lastEvidenceMs: last, silent };
    })
    .toSorted((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
  return { referenceMs, thresholdDays: input.thresholdDays, verdicts };
}
