import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { extractPreCompactRecords } from "../../../src/core/brain/pre-compact-extract.ts";

let vault: string;

const INPUT = Object.freeze({
  createdAt: "2026-05-20T17:00:00.000Z",
  host: "unit-test",
  sessionId: "session-preview",
  turnStart: "turn-1",
  turnEnd: "turn-3",
  text: [
    "Decision: Ship the dry-run preview.",
    "Commitment: Add a parity test.",
    "Outcome: Vault untouched.",
    "Rule: Preview must not mutate.",
    "Open question: Should this be default off?",
  ].join("\n"),
});

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pre-compact-dry-run-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("pre-compact extraction dry-run preview", () => {
  test("dryRun: true returns candidate records but writes nothing to the vault", () => {
    const result = extractPreCompactRecords(vault, { ...INPUT, dryRun: true });

    expect(result.errors).toEqual([]);
    expect(result.records.map((record) => record.payload["extract_type"])).toEqual([
      "decision",
      "commitment",
      "outcome",
      "rule",
      "open_question",
    ]);
    // Nothing persisted — no continuity record, no dream/retire trigger.
    expect(listContinuityRecords(vault)).toHaveLength(0);
  });

  test("dry-run candidate records are deeply equal to the records the real path appends", () => {
    const dryVault = mkdtempSync(join(tmpdir(), "o2b-pre-compact-dry-"));
    try {
      const preview = extractPreCompactRecords(dryVault, { ...INPUT, dryRun: true });
      const real = extractPreCompactRecords(vault, INPUT);
      expect(preview.records).toEqual(real.records);
      expect(preview.skipped).toBe(real.skipped);
      expect(preview.errors).toEqual(real.errors);
      // The real path persisted; the dry-run path did not.
      expect(listContinuityRecords(vault)).toHaveLength(real.records.length);
      expect(listContinuityRecords(dryVault)).toHaveLength(0);
    } finally {
      rmSync(dryVault, { recursive: true, force: true });
    }
  });

  test("dryRun absent or false is byte-identical to today (records persisted)", () => {
    const absent = extractPreCompactRecords(vault, INPUT);
    expect(listContinuityRecords(vault)).toHaveLength(absent.records.length);

    const falseVault = mkdtempSync(join(tmpdir(), "o2b-pre-compact-false-"));
    try {
      const explicitFalse = extractPreCompactRecords(falseVault, { ...INPUT, dryRun: false });
      expect(explicitFalse.records).toEqual(absent.records);
      expect(listContinuityRecords(falseVault)).toHaveLength(explicitFalse.records.length);
    } finally {
      rmSync(falseVault, { recursive: true, force: true });
    }
  });
});
