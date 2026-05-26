/**
 * Brain Integrity Suite (v0.12.0) destructive-from-confirmed gate.
 *
 * Two layers of coverage:
 *
 *   - `shouldGateRetireFromConfirmed` pure decision: every branch of
 *     the gate logic exercised in isolation. No vault, no I/O.
 *   - `dream()` smoke: when the config field is absent, the new
 *     `gated_retires` field on `DreamRunSummary` exists and reads as
 *     an empty array. This preserves the pre-v0.12.0 contract for
 *     every consumer that did not opt in to the gate.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dream,
  shouldGateRetireFromConfirmed,
} from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  type BrainPreference,
} from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const pref = (overrides: Partial<BrainPreference> = {}): BrainPreference => ({
  kind: "brain-preference",
  id: "pref-gate-test",
  created_at: "2026-01-01T00:00:00Z",
  confirmed_at: "2026-01-02T00:00:00Z",
  unconfirmed_until: "2026-01-08T00:00:00Z",
  tags: [],
  topic: "gating",
  status: BRAIN_PREFERENCE_STATUS.confirmed,
  principle: "the gated principle",
  evidenced_by: [],
  applied_count: 1,
  violated_count: 0,
  last_evidence_at: "2026-01-02T00:00:00Z",
  confidence: "high",
  confidence_value: 0.9,
  pinned: false,
  ...overrides,
});

describe("shouldGateRetireFromConfirmed", () => {
  test("returns false when threshold is undefined (default-off)", () => {
    expect(
      shouldGateRetireFromConfirmed(
        pref(),
        BRAIN_RETIRED_REASON.staleNoEvidence,
        undefined,
      ),
    ).toBe(false);
  });

  test("returns false when threshold is 0 or negative", () => {
    expect(
      shouldGateRetireFromConfirmed(
        pref(),
        BRAIN_RETIRED_REASON.staleNoEvidence,
        0,
      ),
    ).toBe(false);
    expect(
      shouldGateRetireFromConfirmed(
        pref(),
        BRAIN_RETIRED_REASON.staleNoEvidence,
        -1,
      ),
    ).toBe(false);
  });

  test("returns true when confirmed + unpinned + evidence below threshold", () => {
    expect(
      shouldGateRetireFromConfirmed(
        pref({ applied_count: 1, violated_count: 0 }),
        BRAIN_RETIRED_REASON.staleNoEvidence,
        3,
      ),
    ).toBe(true);
  });

  test("returns false when accumulated evidence meets or exceeds threshold", () => {
    expect(
      shouldGateRetireFromConfirmed(
        pref({ applied_count: 3, violated_count: 0 }),
        BRAIN_RETIRED_REASON.staleNoEvidence,
        3,
      ),
    ).toBe(false);
    expect(
      shouldGateRetireFromConfirmed(
        pref({ applied_count: 2, violated_count: 1 }),
        BRAIN_RETIRED_REASON.staleNoEvidence,
        3,
      ),
    ).toBe(false);
  });

  test("never gates an operator-initiated user-rejected retire", () => {
    expect(
      shouldGateRetireFromConfirmed(
        pref({ applied_count: 0, violated_count: 0 }),
        BRAIN_RETIRED_REASON.userRejected,
        10,
      ),
    ).toBe(false);
  });

  test("never gates a merge-driven retire", () => {
    expect(
      shouldGateRetireFromConfirmed(
        pref({ applied_count: 0, violated_count: 0 }),
        BRAIN_RETIRED_REASON.mergedInto,
        10,
      ),
    ).toBe(false);
  });

  test("never gates a non-confirmed source (unconfirmed / quarantine)", () => {
    expect(
      shouldGateRetireFromConfirmed(
        pref({
          status: BRAIN_PREFERENCE_STATUS.unconfirmed,
          applied_count: 0,
          violated_count: 0,
        }),
        BRAIN_RETIRED_REASON.expiredUnconfirmed,
        10,
      ),
    ).toBe(false);
    expect(
      shouldGateRetireFromConfirmed(
        pref({
          status: BRAIN_PREFERENCE_STATUS.quarantine,
          applied_count: 0,
          violated_count: 0,
        }),
        BRAIN_RETIRED_REASON.quarantineViolated,
        10,
      ),
    ).toBe(false);
  });

  test("never gates a pinned preference", () => {
    expect(
      shouldGateRetireFromConfirmed(
        pref({ pinned: true, applied_count: 0, violated_count: 0 }),
        BRAIN_RETIRED_REASON.staleNoEvidence,
        10,
      ),
    ).toBe(false);
  });
});

describe("dream() gated_retires field", () => {
  let vault: string;
  let configHome: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-gate-vault-"));
    configHome = mkdtempSync(join(tmpdir(), "o2b-gate-cfg-"));
    const configPath = join(configHome, "config.yaml");
    atomicWriteFileSync(configPath, `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath });
  });

  test("a fresh-bootstrap dream run returns gated_retires as an empty array", () => {
    const summary = dream(vault, {
      now: new Date("2026-05-27T12:00:00Z"),
      dryRun: true,
    });
    expect(Array.isArray(summary.gated_retires)).toBe(true);
    expect(summary.gated_retires).toEqual([]);
  });
});
