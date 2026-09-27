/**
 * `decision_model_call` accounting records.
 *
 * One record per decision request, written through the continuity log
 * with the same gated, fail-open discipline as `generation_report`: a
 * failed write never fails the caller, and with no vault nothing is
 * built. Records exist only while the feature is active, so an install
 * that never enabled it has none.
 *
 * A record carries identifiers and numbers - the use, mode, answering
 * model, token counts, cost, latency, the outcome and a sha-256 of the
 * redacted state - plus each use's own evaluation identifiers (for a
 * rerank, the ordered result paths). It never carries the state, a
 * passage, a prompt or a question text.
 *
 * The same records feed the daily cost gate and `o2b decision-model
 * report`. Nothing trains on them, and operators should not build that
 * on them either.
 */

import { emitGatedTelemetry } from "../brain/continuity/emit.ts";
import { appendContinuityRecord, listContinuityRecords } from "../brain/continuity/store.ts";
import type { ContinuityRecord } from "../brain/continuity/types.ts";
import type { DecisionModelMode, DecisionModelUse, DecisionUsage } from "./contract.ts";

export const DECISION_MODEL_CALL_KIND = "decision_model_call";

export type DecisionCostSource = "reported" | "estimated" | "unknown";

export interface DecisionCallRecordInput {
  readonly use: DecisionModelUse;
  readonly mode: DecisionModelMode;
  readonly provider: string;
  /** Answering model when a reply arrived, else the pinned id. */
  readonly model: string;
  readonly calibrated: boolean;
  readonly questionCount: number;
  readonly candidateCount: number;
  readonly usage?: DecisionUsage;
  readonly inputPriceUsdPerMtok: number | null;
  readonly latencyMs: number;
  /** `ok` or a degrade reason. */
  readonly outcome: string;
  readonly stateHash?: string;
  /** Per-use evaluation identifiers (paths, ids, probabilities), never text. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
}

export function decisionCost(
  usage: DecisionUsage | undefined,
  inputPriceUsdPerMtok: number | null,
): { readonly costUsd: number | null; readonly source: DecisionCostSource } {
  if (usage?.costUsd !== undefined) return { costUsd: usage.costUsd, source: "reported" };
  if (usage?.inputTokens !== undefined && inputPriceUsdPerMtok !== null) {
    return { costUsd: (usage.inputTokens * inputPriceUsdPerMtok) / 1_000_000, source: "estimated" };
  }
  return { costUsd: null, source: "unknown" };
}

/** Emit one record; returns null when there is no vault or the write failed. */
export function emitDecisionModelCall(
  vault: string | null,
  input: DecisionCallRecordInput,
): ContinuityRecord | null {
  return emitGatedTelemetry(vault, (v) => {
    const cost = decisionCost(input.usage, input.inputPriceUsdPerMtok);
    const payload: Record<string, unknown> = {
      use: input.use,
      mode: input.mode,
      provider: input.provider,
      model: input.model,
      calibrated: input.calibrated,
      question_count: input.questionCount,
      candidate_count: input.candidateCount,
      ...(input.usage?.inputTokens !== undefined ? { input_tokens: input.usage.inputTokens } : {}),
      ...(input.usage?.outputTokens !== undefined
        ? { output_tokens: input.usage.outputTokens }
        : {}),
      ...(cost.costUsd !== null ? { cost_usd: cost.costUsd } : {}),
      cost_source: cost.source,
      latency_ms: Math.max(0, Math.round(input.latencyMs)),
      outcome: input.outcome,
      ...(input.stateHash !== undefined ? { state_hash: input.stateHash } : {}),
      ...input.details,
    };
    return appendContinuityRecord(v, {
      kind: DECISION_MODEL_CALL_KIND,
      createdAt: input.createdAt ?? new Date().toISOString(),
      sourceRefs: [],
      payload,
    });
  });
}

/** Start of the current UTC day, canonical ISO form. */
export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** Records of this kind, oldest first, optionally since an instant. */
export function listDecisionModelCalls(
  vault: string,
  since?: string,
): ReadonlyArray<ContinuityRecord> {
  return listContinuityRecords(vault, {
    kind: DECISION_MODEL_CALL_KIND,
    ...(since !== undefined ? { since } : {}),
  });
}

/**
 * Today's (UTC) spend: the sum of recorded `cost_usd`. Records without a
 * cost (unknown price) contribute nothing. Fail-open: an unreadable log
 * reads as 0 spend only when it cannot be read at all, and the caller
 * decides what that means.
 */
export function todaySpendUsd(vault: string, now: Date = new Date()): number {
  let total = 0;
  for (const record of listDecisionModelCalls(vault, utcDayStart(now))) {
    const cost = record.payload["cost_usd"];
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
  }
  return total;
}
