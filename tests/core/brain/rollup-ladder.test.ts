/**
 * Count-triggered fact rollup ladder (S3, t_c5263e27): pure ladder
 * planning - thresholds, counter resets, composition, and idempotency.
 */

import { expect, test } from "bun:test";

import {
  DEFAULT_FACT_ROLLUP_THRESHOLD,
  DEFAULT_ROLLUP_IDENTITY_THRESHOLD,
  planRollupLadder,
  resolveRollupThresholds,
  ROLLUP_TIER,
  type RollupThresholds,
} from "../../../src/core/brain/rollup-ladder.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../../src/core/brain/policy.ts";

const THRESHOLDS: RollupThresholds = { fact: 5, identity: 2 };
const RUN_ID = "dream-2026-07-19-100000";

test("below threshold nothing fires and no counters move", () => {
  const plan = planRollupLadder({
    factCount: 4,
    ledger: null,
    thresholds: THRESHOLDS,
    runId: RUN_ID,
  });
  expect(plan.fired).toBe(false);
  expect(plan.entries).toHaveLength(0);
  expect(plan.ledger.baselines[ROLLUP_TIER.fact] ?? 0).toBe(0);
});

test("reaching the fact threshold fires one rollup and resets the counter", () => {
  const plan = planRollupLadder({
    factCount: 5,
    ledger: null,
    thresholds: THRESHOLDS,
    runId: RUN_ID,
  });
  expect(plan.fired).toBe(true);
  expect(plan.entries).toHaveLength(1);
  const entry = plan.entries[0]!;
  expect(entry.tier).toBe(ROLLUP_TIER.fact);
  expect(entry.produces).toBe(ROLLUP_TIER.rollup);
  expect(entry.fromCount).toBe(0);
  expect(entry.toCount).toBe(5);
  expect(entry.newSinceLast).toBe(5);
  expect(entry.envelope.status).toBe("needs-llm-step");
  expect(entry.envelope.target_path).toContain(RUN_ID);
  // Counter reset recorded in the ledger.
  expect(plan.ledger.baselines[ROLLUP_TIER.fact]).toBe(5);
  expect(plan.ledger.produced[ROLLUP_TIER.fact]).toBe(1);
});

test("a fired plan is idempotent: replaying it moves no counter", () => {
  const first = planRollupLadder({
    factCount: 5,
    ledger: null,
    thresholds: THRESHOLDS,
    runId: RUN_ID,
  });
  const second = planRollupLadder({
    factCount: 5,
    ledger: first.ledger,
    thresholds: THRESHOLDS,
    runId: RUN_ID,
  });
  expect(second.fired).toBe(false);
  expect(second.entries).toHaveLength(0);
});

test("the ladder composes: enough fact rollups cascade into an identity rollup", () => {
  // identity threshold 1 means the single fact rollup fired this pass
  // immediately satisfies the rollup -> identity rung.
  const plan = planRollupLadder({
    factCount: 5,
    ledger: null,
    thresholds: { fact: 5, identity: 1 },
    runId: RUN_ID,
  });
  expect(plan.entries).toHaveLength(2);
  expect(plan.entries.map((e) => e.tier)).toEqual([ROLLUP_TIER.fact, ROLLUP_TIER.rollup]);
  expect(plan.entries[1]!.produces).toBe(ROLLUP_TIER.identity);
  expect(plan.ledger.produced[ROLLUP_TIER.rollup]).toBe(1);
});

test("new facts beyond the last rollup re-arm the fact rung", () => {
  const first = planRollupLadder({
    factCount: 5,
    ledger: null,
    thresholds: THRESHOLDS,
    runId: RUN_ID,
  });
  // Five more facts since the reset (10 total) crosses the threshold again.
  const second = planRollupLadder({
    factCount: 10,
    ledger: first.ledger,
    thresholds: THRESHOLDS,
    runId: RUN_ID,
  });
  expect(second.fired).toBe(true);
  expect(second.entries[0]!.fromCount).toBe(5);
  expect(second.entries[0]!.toCount).toBe(10);
});

test("thresholds resolve from config, falling back to the named constants", () => {
  expect(resolveRollupThresholds(DEFAULT_BRAIN_CONFIG)).toEqual({
    fact: DEFAULT_FACT_ROLLUP_THRESHOLD,
    identity: DEFAULT_ROLLUP_IDENTITY_THRESHOLD,
  });
  const overridden = resolveRollupThresholds({
    ...DEFAULT_BRAIN_CONFIG,
    rollup: { fact_threshold: 3 },
  });
  expect(overridden.fact).toBe(3);
  expect(overridden.identity).toBe(DEFAULT_ROLLUP_IDENTITY_THRESHOLD);
});
