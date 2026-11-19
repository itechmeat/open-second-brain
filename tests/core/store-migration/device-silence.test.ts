/**
 * The pure "retired by silence" rule (change stale-device-retirement,
 * design D1-D3) as one table: evidence kinds x ages x the threshold x 0 x
 * the clock cases.
 */
import { describe, expect, test } from "bun:test";

import {
  DAY_MS,
  judgeSilence,
  type SilenceInput,
} from "../../../src/core/store-migration/device-silence.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const ago = (days: number): number => NOW - days * DAY_MS;

interface Row {
  readonly name: string;
  readonly input: SilenceInput;
  /** device -> silent */
  readonly silent: Readonly<Record<string, boolean>>;
  /** device -> last evidence ms (null when none) */
  readonly last?: Readonly<Record<string, number | null>>;
  readonly reference: number | null;
}

/** This machine's own newest record, written now. */
const HERE = [NOW];

const TABLE: ReadonlyArray<Row> = [
  {
    name: "a shard or row dated inside the threshold keeps the device pending",
    input: {
      devices: [{ device: "b", evidenceMs: ago(29), cohortMs: ago(90) }],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { b: false },
    last: { b: ago(29) },
    reference: NOW,
  },
  {
    name: "evidence exactly at the threshold is not past it",
    input: {
      devices: [{ device: "b", evidenceMs: ago(30), cohortMs: null }],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { b: false },
    reference: NOW,
  },
  {
    name: "evidence past the threshold retires the device",
    input: {
      devices: [{ device: "b", evidenceMs: ago(31), cohortMs: null }],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { b: true },
    last: { b: ago(31) },
    reference: NOW,
  },
  {
    name: "threshold 0 turns the rule off, however old the evidence",
    input: {
      devices: [{ device: "b", evidenceMs: ago(4000), cohortMs: ago(4000) }],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 0,
    },
    silent: { b: false },
    reference: NOW,
  },
  {
    name: "a device with no dated trace takes its cohort record's clock",
    input: {
      devices: [
        { device: "c", evidenceMs: null, cohortMs: ago(45) },
        { device: "d", evidenceMs: null, cohortMs: ago(10) },
      ],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { c: true, d: false },
    last: { c: ago(45), d: ago(10) },
    reference: NOW,
  },
  {
    name: "a device with neither a trace nor a cohort record is never retired",
    input: {
      devices: [{ device: "e", evidenceMs: null, cohortMs: null }],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { e: false },
    last: { e: null },
    reference: NOW,
  },
  {
    name: "a peer stamping years ahead counts as now and retires no one",
    input: {
      devices: [
        { device: "future", evidenceMs: NOW + 900 * DAY_MS, cohortMs: null },
        { device: "b", evidenceMs: ago(10), cohortMs: null },
      ],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { future: false, b: false },
    // The future stamp is ignored for the reference: this machine's record is the newest.
    reference: NOW,
  },
  {
    name: "a peer stamping years ahead does not turn a stale view into absolute judging",
    input: {
      // This machine has seen nothing newer than 60 days ago (its vault
      // sync was paused); b is 20 days older than that, so relatively fresh.
      devices: [
        { device: "future", evidenceMs: NOW + 900 * DAY_MS, cohortMs: null },
        { device: "b", evidenceMs: ago(80), cohortMs: null },
      ],
      otherEvidenceMs: [ago(60)],
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { future: false, b: false },
    last: { future: NOW + 900 * DAY_MS, b: ago(80) },
    reference: ago(60),
  },
  {
    name: "evidence only in the future: no reference, nothing retired",
    input: {
      devices: [
        { device: "future", evidenceMs: NOW + 900 * DAY_MS, cohortMs: null },
        { device: "c", evidenceMs: null, cohortMs: ago(400) },
      ],
      otherEvidenceMs: [],
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { future: false, c: false },
    reference: null,
  },
  {
    name: "this machine's clock behind the evidence: evidence after the clock is ignored, fewer devices retire",
    input: {
      devices: [
        { device: "b", evidenceMs: ago(40), cohortMs: null },
        { device: "c", evidenceMs: ago(65), cohortMs: null },
      ],
      otherEvidenceMs: HERE,
      wallMs: ago(20),
      thresholdDays: 30,
    },
    silent: { b: false, c: false },
    reference: ago(40),
  },
  {
    name: "this machine's clock far ahead, nothing written under it yet: the newest evidence is the reference",
    input: {
      devices: [
        { device: "b", evidenceMs: ago(10), cohortMs: null },
        { device: "c", evidenceMs: ago(60), cohortMs: null },
      ],
      otherEvidenceMs: HERE,
      wallMs: NOW + 3650 * DAY_MS,
      thresholdDays: 30,
    },
    silent: { b: false, c: true },
    reference: NOW,
  },
  {
    name: "no evidence anywhere: no reference, nothing retired",
    input: {
      devices: [{ device: "c", evidenceMs: null, cohortMs: null }],
      otherEvidenceMs: [],
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { c: false },
    reference: null,
  },
  {
    name: "a single live machine with stale ids retires every one of them",
    input: {
      devices: [
        { device: "old-laptop", evidenceMs: ago(200), cohortMs: ago(5) },
        { device: "old-phone", evidenceMs: ago(90), cohortMs: ago(5) },
      ],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 30,
    },
    silent: { "old-laptop": true, "old-phone": true },
    reference: NOW,
  },
  {
    name: "a larger threshold keeps a 40-day-old device pending",
    input: {
      devices: [{ device: "b", evidenceMs: ago(40), cohortMs: null }],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 60,
    },
    silent: { b: false },
    reference: NOW,
  },
];

describe("judgeSilence", () => {
  for (const row of TABLE) {
    test(row.name, () => {
      const out = judgeSilence(row.input);
      expect(out.referenceMs).toBe(row.reference);
      expect(out.thresholdDays).toBe(row.input.thresholdDays);
      const silent = Object.fromEntries(out.verdicts.map((v) => [v.device, v.silent]));
      expect(silent).toEqual({ ...row.silent });
      for (const [device, ms] of Object.entries(row.last ?? {})) {
        expect(out.verdicts.find((v) => v.device === device)?.lastEvidenceMs).toBe(ms);
      }
    });
  }

  test("verdicts come back sorted by device id", () => {
    const out = judgeSilence({
      devices: [
        { device: "z", evidenceMs: ago(1), cohortMs: null },
        { device: "a", evidenceMs: ago(1), cohortMs: null },
      ],
      otherEvidenceMs: HERE,
      wallMs: NOW,
      thresholdDays: 30,
    });
    expect(out.verdicts.map((v) => v.device)).toEqual(["a", "z"]);
  });
});
