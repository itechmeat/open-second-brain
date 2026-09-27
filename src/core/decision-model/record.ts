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
 *
 * Records written by the eval gate and by `check --ping` carry an
 * `origin` (`eval`, `ping`), so the report can keep them out of the
 * shadow agreement. They still count toward the daily gate: they are
 * real spend.
 */

import { emitGatedTelemetry } from "../brain/continuity/emit.ts";
import { appendContinuityRecord, listContinuityRecords } from "../brain/continuity/store.ts";
import type { ContinuityRecord } from "../brain/continuity/types.ts";
import type {
  DecisionCallOrigin,
  DecisionModelMode,
  DecisionModelUse,
  DecisionUsage,
} from "./contract.ts";

export const DECISION_MODEL_CALL_KIND = "decision_model_call";

export type DecisionCostSource = "reported" | "estimated" | "unknown";

export interface DecisionCallRecordInput {
  /** The use, or `ping` for the connectivity check. */
  readonly use: DecisionModelUse | "ping";
  readonly mode: DecisionModelMode;
  readonly provider: string;
  /** Answering model when a reply arrived, else the pinned id. */
  readonly model: string;
  readonly calibrated: boolean;
  readonly questionCount: number;
  readonly candidateCount: number;
  readonly usage?: DecisionUsage;
  readonly inputPriceUsdPerMtok: number | null;
  /**
   * Output price, set only for `llm-emulation` (the one route that bills
   * output); its cost is estimated from both prices or unknown.
   */
  readonly outputPriceUsdPerMtok?: number | null;
  readonly latencyMs: number;
  /** `ok` or a degrade reason. */
  readonly outcome: string;
  readonly stateHash?: string;
  /** Per-use evaluation identifiers (paths, ids, probabilities), never text. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly origin?: DecisionCallOrigin;
  readonly createdAt?: string;
}

/**
 * The cost of one request. A reported cost wins. Otherwise it is estimated
 * from the input price, plus the output price when one is given (only
 * `llm-emulation` bills output; without its output tokens the cost is
 * unknown rather than understated).
 */
export function decisionCost(
  usage: DecisionUsage | undefined,
  inputPriceUsdPerMtok: number | null,
  outputPriceUsdPerMtok: number | null = null,
): { readonly costUsd: number | null; readonly source: DecisionCostSource } {
  if (usage?.costUsd !== undefined) return { costUsd: usage.costUsd, source: "reported" };
  if (usage?.inputTokens !== undefined && inputPriceUsdPerMtok !== null) {
    const input = usage.inputTokens * inputPriceUsdPerMtok;
    if (outputPriceUsdPerMtok === null) {
      return { costUsd: input / 1_000_000, source: "estimated" };
    }
    if (usage.outputTokens === undefined) return { costUsd: null, source: "unknown" };
    return {
      costUsd: (input + usage.outputTokens * outputPriceUsdPerMtok) / 1_000_000,
      source: "estimated",
    };
  }
  return { costUsd: null, source: "unknown" };
}

/** Emit one record; returns null when there is no vault or the write failed. */
export function emitDecisionModelCall(
  vault: string | null,
  input: DecisionCallRecordInput,
): ContinuityRecord | null {
  return emitGatedTelemetry(vault, (v) => {
    const cost = decisionCost(
      input.usage,
      input.inputPriceUsdPerMtok,
      input.outputPriceUsdPerMtok ?? null,
    );
    // Per-use details go first so they can never overwrite an accounting
    // field (the cost gate sums `cost_usd`).
    const payload: Record<string, unknown> = {
      ...input.details,
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
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    };
    const createdAt = input.createdAt ?? new Date().toISOString();
    const written = appendContinuityRecord(v, {
      kind: DECISION_MODEL_CALL_KIND,
      createdAt,
      sourceRefs: [],
      payload,
    });
    if (cost.costUsd !== null) noteSpend(v, createdAt, cost.costUsd);
    return written;
  });
}

/**
 * Commit-side records of the extract-signals turn pre-filter (Part 4):
 * which written items cited a plan turn. Session and turn ids only.
 */
export const DECISION_MODEL_EXTRACT_COMMIT_KIND = "decision_model_extract_commit";

/** Extract pre-filter commit records, oldest first, optionally since an instant. */
export function listDecisionModelExtractCommits(
  vault: string,
  since?: string,
): ReadonlyArray<ContinuityRecord> {
  return listContinuityRecords(vault, {
    kind: DECISION_MODEL_EXTRACT_COMMIT_KIND,
    ...(since !== undefined ? { since } : {}),
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
 * How long a loaded day total is trusted before the log is read again.
 * Within this window the total moves only by this process's own records;
 * the reload picks up what other processes spent meanwhile.
 */
export const SPEND_CACHE_TTL_MS = 60_000;

interface SpendEntry {
  /** The UTC day this total is for (`YYYY-MM-DD`). */
  readonly day: string;
  total: number;
  readonly loadedAtMs: number;
}

/**
 * Today's spend per vault, loaded from the log once and then kept current
 * by this process's own writes, so the gate does not parse the month's
 * continuity shard on every request.
 */
const SPEND_CACHE = new Map<string, SpendEntry>();

/** Tests only: forget every loaded total. */
export function resetDecisionSpendCache(): void {
  SPEND_CACHE.clear();
}

function noteSpend(vault: string, createdAt: string, costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  const entry = SPEND_CACHE.get(vault);
  if (entry !== undefined && entry.day === createdAt.slice(0, 10)) entry.total += costUsd;
}

function readDaySpend(vault: string, now: Date): number {
  let total = 0;
  for (const record of listDecisionModelCalls(vault, utcDayStart(now))) {
    const cost = record.payload["cost_usd"];
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
  }
  return total;
}

/**
 * Today's (UTC) spend: the sum of recorded `cost_usd`. Records without a
 * cost (unknown price) contribute nothing. The total is read from the log
 * at most once per {@link SPEND_CACHE_TTL_MS} and per UTC day, and this
 * process's own records are added as they are written; other processes'
 * records show up on the next reload, which keeps the gate a soft limit
 * across processes. A log that cannot be read throws, and the caller
 * decides what that means (the gate treats it as over the limit).
 */
export function todaySpendUsd(vault: string, now: Date = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  const nowMs = now.getTime();
  const entry = SPEND_CACHE.get(vault);
  if (
    entry !== undefined &&
    entry.day === day &&
    nowMs >= entry.loadedAtMs &&
    nowMs - entry.loadedAtMs < SPEND_CACHE_TTL_MS
  ) {
    return entry.total;
  }
  const total = readDaySpend(vault, now);
  SPEND_CACHE.set(vault, { day, total, loadedAtMs: nowMs });
  return total;
}
