import { describe, expect, test } from "bun:test";

import { BRAIN_GUARDRAIL_DEFAULTS } from "../../../../src/core/brain/policy.ts";
import { applySelfApprovalGuardrail } from "../../../../src/core/brain/trust/self-approval-guardrail.ts";

describe("applySelfApprovalGuardrail - default config", () => {
  const cfg = BRAIN_GUARDRAIL_DEFAULTS;

  test("promotes when all thresholds met (defaults)", () => {
    const r = applySelfApprovalGuardrail(
      { signal_count: 2, distinct_agents: 1, age_days: 0 },
      cfg,
    );
    expect(r.decision).toBe("promote");
    expect(r.failed_gates).toEqual([]);
  });

  test("quarantines when signal count below min_signals (default 2)", () => {
    const r = applySelfApprovalGuardrail(
      { signal_count: 1, distinct_agents: 1, age_days: 0 },
      cfg,
    );
    expect(r.decision).toBe("quarantine");
    expect(r.failed_gates).toContain("min_signals");
  });

  test("default min_age_days: 0 means the age gate never fails", () => {
    const r = applySelfApprovalGuardrail(
      { signal_count: 5, distinct_agents: 1, age_days: 0 },
      cfg,
    );
    expect(r.decision).toBe("promote");
  });
});

describe("applySelfApprovalGuardrail - tighter config", () => {
  test("cross-agent threshold: 1 agent fails when min_distinct_agents=2", () => {
    const cfg = {
      ...BRAIN_GUARDRAIL_DEFAULTS,
      promotion_min_distinct_agents: 2,
    };
    const r = applySelfApprovalGuardrail(
      { signal_count: 5, distinct_agents: 1, age_days: 30 },
      cfg,
    );
    expect(r.decision).toBe("quarantine");
    expect(r.failed_gates).toContain("min_distinct_agents");
  });

  test("age threshold: too-fresh cluster fails when min_age_days=7", () => {
    const cfg = {
      ...BRAIN_GUARDRAIL_DEFAULTS,
      promotion_min_age_days: 7,
    };
    const r = applySelfApprovalGuardrail(
      { signal_count: 5, distinct_agents: 2, age_days: 3 },
      cfg,
    );
    expect(r.decision).toBe("quarantine");
    expect(r.failed_gates).toContain("min_age_days");
  });

  test("multiple failed gates surface together", () => {
    const cfg = {
      ...BRAIN_GUARDRAIL_DEFAULTS,
      promotion_min_signals: 5,
      promotion_min_distinct_agents: 3,
      promotion_min_age_days: 10,
    };
    const r = applySelfApprovalGuardrail(
      { signal_count: 1, distinct_agents: 1, age_days: 0 },
      cfg,
    );
    expect(r.decision).toBe("quarantine");
    expect([...r.failed_gates].sort()).toEqual([
      "min_age_days",
      "min_distinct_agents",
      "min_signals",
    ]);
  });
});

describe("applySelfApprovalGuardrail - structural invariants", () => {
  test("returned object is frozen", () => {
    const r = applySelfApprovalGuardrail(
      { signal_count: 2, distinct_agents: 1, age_days: 0 },
      BRAIN_GUARDRAIL_DEFAULTS,
    );
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.failed_gates)).toBe(true);
  });
});
