/**
 * Self-approval guardrail (v0.10.16).
 *
 * The dream pass clusters same-sign signals into preference
 * candidates. Before promoting a candidate to `confirmed`, the
 * guardrail checks three configurable thresholds:
 *
 *   - `promotion_min_signals`         - cluster size (signal count)
 *   - `promotion_min_distinct_agents` - how many distinct agents
 *                                       raised same-sign signals
 *   - `promotion_min_age_days`        - age (in days) of the
 *                                       earliest signal in the
 *                                       cluster
 *
 * When any threshold fails, promotion is blocked and the candidate
 * lands in the quarantine list with the set of failing gates. The
 * gates run independently so multiple failures surface together.
 *
 * Defaults from `BRAIN_GUARDRAIL_DEFAULTS` are tuned to keep
 * pre-v0.10.16 behaviour bit-identical: `min_signals=2`,
 * `min_distinct_agents=1`, `min_age_days=0`.
 */

import type { ResolvedBrainGuardrailConfig } from "../types.ts";

export interface SelfApprovalInput {
  /** Count of same-sign signals in the candidate cluster. */
  readonly signal_count: number;
  /** Number of distinct agents that raised same-sign signals. */
  readonly distinct_agents: number;
  /** Age (in days) of the earliest signal in the cluster. */
  readonly age_days: number;
}

export interface SelfApprovalResult {
  readonly decision: "promote" | "quarantine";
  /** Names of gates that blocked promotion. Empty on `promote`. */
  readonly failed_gates: ReadonlyArray<string>;
}

export function applySelfApprovalGuardrail(
  input: SelfApprovalInput,
  config: ResolvedBrainGuardrailConfig,
): SelfApprovalResult {
  const failed: string[] = [];

  if (input.signal_count < config.promotion_min_signals) {
    failed.push("min_signals");
  }
  if (input.distinct_agents < config.promotion_min_distinct_agents) {
    failed.push("min_distinct_agents");
  }
  if (input.age_days < config.promotion_min_age_days) {
    failed.push("min_age_days");
  }

  return Object.freeze({
    decision: failed.length === 0 ? ("promote" as const) : ("quarantine" as const),
    failed_gates: Object.freeze(failed.slice()),
  });
}
