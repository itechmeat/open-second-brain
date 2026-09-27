/**
 * `o2b decision-model report --use recall_inject`: the evaluation view of
 * the recall-inject hook filter (issue #213, Part 9).
 *
 * Reads the `recall_inject` `decision_model_call` records and, beside
 * them, the hook channel of recall telemetry over the same window, so the
 * added latency can be read next to what the hook delivered and how often
 * it timed out. Counts, rates and percentiles only.
 *
 * Moving the use to `enforce` on a machine requires p95 added latency
 * below the sub-budget (`decision_model_hook_budget_ms`) and no increase
 * in hook timeouts; both numbers are here.
 */

import type { ContinuityRecord } from "../../brain/continuity/types.ts";
import { RECALL_INJECT_FAULT } from "../../brain/recall-inject.ts";
import { listRecallTelemetry, RECALL_CHANNEL } from "../../brain/recall-telemetry.ts";
import { DECISION_MODEL_CALL_KIND, listDecisionModelCalls } from "../record.ts";

export interface RecallInjectUseReport {
  readonly use: "recall_inject";
  readonly since: string | null;
  /** Requests attempted by ordinary prompts (eval and ping records excluded). */
  readonly calls: number;
  readonly by_mode: Readonly<Record<string, number>>;
  readonly outcomes: Readonly<Record<string, number>>;
  /** Latency the filter added to a prompt, over every attempted request. */
  readonly added_latency_p50_ms: number | null;
  readonly added_latency_p95_ms: number | null;
  /** Share of attempted requests that ended in `timeout`; null with none. */
  readonly timeout_rate: number | null;
  /**
   * Share of answered requests where the brief was (enforce) or would have
   * been (shadow) withheld; null with no answer.
   */
  readonly abstain_rate: number | null;
  /** Notes removed (enforce) or that enforce would remove (shadow), summed. */
  readonly notes_dropped: number;
  /** Mean notes dropped per answered request; null with no answer. */
  readonly notes_dropped_mean: number | null;
  /** The hook channel of recall telemetry over the same window. */
  readonly recall_telemetry: {
    readonly decisions: number;
    readonly inject: number;
    readonly abstain: number;
    readonly error: number;
    /** Abstentions with reason `decision_model_abstain`. */
    readonly decision_model_abstain: number;
    /** Retrieval timeouts (`fault: timeout`). */
    readonly retrieval_timeouts: number;
    /** Hook self-watchdog exits (`fault: hook_ceiling_exceeded`). */
    readonly hook_ceiling_exceeded: number;
  };
}

function percentile(sorted: ReadonlyArray<number>, p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/** Outcomes that never sent a request, so they add no latency. */
const NOT_SENT_OUTCOMES = new Set(["cost_gate", "budget"]);

function recallInjectCalls(vault: string, since?: string): ReadonlyArray<ContinuityRecord> {
  return listDecisionModelCalls(vault, since).filter(
    (r) =>
      r.kind === DECISION_MODEL_CALL_KIND &&
      r.payload["use"] === "recall_inject" &&
      r.payload["origin"] === undefined,
  );
}

export function buildRecallInjectUseReport(
  vault: string,
  opts: { readonly since?: string } = {},
): RecallInjectUseReport {
  const records = recallInjectCalls(vault, opts.since);
  const byMode: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const latencies: number[] = [];
  let attempted = 0;
  let timeouts = 0;
  let answered = 0;
  let abstained = 0;
  let dropped = 0;
  for (const record of records) {
    const p = record.payload;
    const mode = typeof p["mode"] === "string" ? p["mode"] : "unknown";
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    const outcome = typeof p["outcome"] === "string" ? p["outcome"] : "unknown";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (!NOT_SENT_OUTCOMES.has(outcome)) {
      attempted++;
      if (typeof p["latency_ms"] === "number") latencies.push(p["latency_ms"]);
      if (outcome === "timeout") timeouts++;
    }
    if (outcome === "ok") {
      answered++;
      if (p["abstained"] === true) abstained++;
      if (typeof p["notes_dropped"] === "number") dropped += p["notes_dropped"];
    }
  }
  latencies.sort((a, b) => a - b);

  const telemetry = {
    decisions: 0,
    inject: 0,
    abstain: 0,
    error: 0,
    decision_model_abstain: 0,
    retrieval_timeouts: 0,
    hook_ceiling_exceeded: 0,
  };
  for (const record of listRecallTelemetry(vault, {
    channel: RECALL_CHANNEL.hook,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
  })) {
    const meta = record.payload["metadata"];
    if (meta === null || typeof meta !== "object") continue;
    const m = meta as Record<string, unknown>;
    telemetry.decisions++;
    if (m["decision"] === "inject") telemetry.inject++;
    else if (m["decision"] === "abstain") {
      telemetry.abstain++;
      if (m["reason"] === "decision_model_abstain") telemetry.decision_model_abstain++;
    } else if (m["decision"] === "error") {
      telemetry.error++;
      if (m["fault"] === RECALL_INJECT_FAULT.timeout) telemetry.retrieval_timeouts++;
      if (m["fault"] === RECALL_INJECT_FAULT.hookCeilingExceeded) telemetry.hook_ceiling_exceeded++;
    }
  }

  return {
    use: "recall_inject",
    since: opts.since ?? null,
    calls: records.length,
    by_mode: byMode,
    outcomes,
    added_latency_p50_ms: percentile(latencies, 0.5),
    added_latency_p95_ms: percentile(latencies, 0.95),
    timeout_rate: attempted > 0 ? timeouts / attempted : null,
    abstain_rate: answered > 0 ? abstained / answered : null,
    notes_dropped: dropped,
    notes_dropped_mean: answered > 0 ? dropped / answered : null,
    recall_telemetry: telemetry,
  };
}

function pct(rate: number | null): string {
  return rate === null ? "-" : `${(rate * 100).toFixed(1)}%`;
}

export function renderRecallInjectUseReport(report: RecallInjectUseReport): string {
  const modes = Object.entries(report.by_mode)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const outcomes = Object.entries(report.outcomes)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const t = report.recall_telemetry;
  return [
    `  recall_inject: ${report.calls} call(s)` + (modes !== "" ? ` (${modes}; ${outcomes})` : ""),
    `    added latency p50 ${report.added_latency_p50_ms ?? "-"}ms, ` +
      `p95 ${report.added_latency_p95_ms ?? "-"}ms; timeout rate ${pct(report.timeout_rate)}`,
    `    abstain rate ${pct(report.abstain_rate)}; notes dropped ${report.notes_dropped}` +
      (report.notes_dropped_mean !== null
        ? ` (mean ${report.notes_dropped_mean.toFixed(2)} per answer)`
        : ""),
    `    hook recall telemetry: ${t.decisions} decision(s): inject ${t.inject}, ` +
      `abstain ${t.abstain} (decision_model_abstain ${t.decision_model_abstain}), ` +
      `error ${t.error} (retrieval timeouts ${t.retrieval_timeouts}, ` +
      `hook ceiling ${t.hook_ceiling_exceeded})`,
  ].join("\n");
}
