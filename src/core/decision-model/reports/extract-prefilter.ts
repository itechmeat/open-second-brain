/**
 * `o2b decision-model report --use extract_prefilter`: the evaluation of
 * the turn pre-filter before the `extract-signals` envelope (issue #213,
 * Part 4).
 *
 * Three metrics, from records only (identifiers and numbers, never text):
 *
 *   - regret: committed items whose cited `source_turn` scored below the
 *     threshold in the latest shadow plan of that session before the
 *     commit. In shadow nothing is dropped, so the host still saw the
 *     turn and could mine it; each such item is a signal `enforce` would
 *     have lost. The target is zero.
 *   - drop share: scored turns (and their clipped characters) below the
 *     threshold, over all scored turns.
 *   - skip share: plans in which every mined turn scored below the
 *     threshold, so `enforce` would skip the envelope and the round trip.
 *
 * `enforce` is recommended only after at least a week of real sessions in
 * shadow with zero regret; otherwise lower the threshold or stay in shadow.
 */

import type { ContinuityRecord } from "../../brain/continuity/types.ts";
import { EXTRACT_PREFILTER_DROP_BELOW } from "../questions.ts";
import { listDecisionModelCalls, listDecisionModelExtractCommits } from "../record.ts";

const USE = "extract_prefilter";
/** Shadow evidence span below which `enforce` is never recommended. */
const MIN_SHADOW_DAYS = 7;

export interface ExtractPrefilterReport {
  readonly since: string | null;
  readonly threshold: number;
  /** Plans with at least one scored turn. */
  readonly plans: number;
  readonly scored_turns: number;
  readonly dropped_turns: number;
  readonly drop_share_turns: number | null;
  readonly scored_chars: number;
  readonly dropped_chars: number;
  readonly drop_share_chars: number | null;
  /** Plans whose every mined turn scored below the threshold. */
  readonly skippable_plans: number;
  readonly skip_share: number | null;
  /** Committed items that cited a known turn id. */
  readonly cited_items: number;
  /** Cited items whose turn has a shadow score before the commit. */
  readonly evaluated_items: number;
  readonly regret_items: number;
  readonly regret_share: number | null;
  /** Days between the first and last shadow plan. */
  readonly shadow_span_days: number;
  readonly recommendation: "stay_in_shadow" | "enforce_possible" | "lower_threshold";
}

function numbers(value: unknown): Array<number | null> | null {
  if (!Array.isArray(value)) return null;
  return value.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : null;
}

interface PlanAgg {
  readonly sessionId: string;
  readonly mode: string;
  readonly createdAt: string;
  readonly turnCount: number;
  readonly scores: Map<string, number>;
  readonly chars: Map<string, number>;
  readonly threshold: number;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

export function buildExtractPrefilterReport(
  vault: string,
  opts: { readonly since?: string } = {},
): ExtractPrefilterReport {
  const calls = listDecisionModelCalls(vault, opts.since).filter(
    (r) =>
      r.payload["use"] === USE &&
      r.payload["outcome"] === "ok" &&
      r.payload["origin"] === undefined,
  );
  const plans = new Map<string, PlanAgg>();
  for (const record of calls) {
    const p = record.payload;
    const planId = typeof p["correlation_id"] === "string" ? p["correlation_id"] : null;
    const sessionId = typeof p["session_id"] === "string" ? p["session_id"] : null;
    const ids = strings(p["turn_ids"]);
    const probs = numbers(p["probabilities"]);
    const chars = numbers(p["turn_chars"]);
    if (planId === null || sessionId === null || ids === null || probs === null) continue;
    const plan: PlanAgg = plans.get(planId) ?? {
      sessionId,
      mode: typeof p["mode"] === "string" ? p["mode"] : "shadow",
      createdAt: record.createdAt,
      turnCount: typeof p["plan_turn_count"] === "number" ? p["plan_turn_count"] : 0,
      scores: new Map(),
      chars: new Map(),
      threshold: typeof p["threshold"] === "number" ? p["threshold"] : EXTRACT_PREFILTER_DROP_BELOW,
    };
    ids.forEach((id, k) => {
      const prob = probs[k];
      if (prob === null || prob === undefined) return;
      plan.scores.set(id, prob);
      plan.chars.set(id, chars?.[k] ?? 0);
    });
    plans.set(planId, plan);
  }

  let scored = 0;
  let dropped = 0;
  let scoredChars = 0;
  let droppedChars = 0;
  let skippable = 0;
  let counted = 0;
  const shadowTimes: number[] = [];
  for (const plan of plans.values()) {
    if (plan.scores.size === 0) continue;
    counted++;
    let below = 0;
    for (const [id, prob] of plan.scores) {
      const c = plan.chars.get(id) ?? 0;
      scored++;
      scoredChars += c;
      if (prob < plan.threshold) {
        below++;
        dropped++;
        droppedChars += c;
      }
    }
    if (plan.turnCount > 0 && below === plan.turnCount) skippable++;
    if (plan.mode === "shadow") shadowTimes.push(Date.parse(plan.createdAt));
  }

  // Regret: each cited turn against the latest shadow plan of its session
  // created at or before the commit.
  const shadowBySession = new Map<string, PlanAgg[]>();
  for (const plan of plans.values()) {
    if (plan.mode !== "shadow") continue;
    const list = shadowBySession.get(plan.sessionId) ?? [];
    list.push(plan);
    shadowBySession.set(plan.sessionId, list);
  }
  for (const list of shadowBySession.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  let cited = 0;
  let evaluated = 0;
  let regret = 0;
  const commits: ReadonlyArray<ContinuityRecord> = listDecisionModelExtractCommits(
    vault,
    opts.since,
  );
  for (const commit of commits) {
    const sessionId = commit.payload["session_id"];
    const turns = strings(commit.payload["source_turns"]);
    if (typeof sessionId !== "string" || turns === null) continue;
    const candidates = (shadowBySession.get(sessionId) ?? []).filter(
      (plan) => plan.createdAt <= commit.createdAt,
    );
    for (const turn of turns) {
      cited++;
      const plan = candidates.find((c) => c.scores.has(turn));
      if (plan === undefined) continue;
      evaluated++;
      if (plan.scores.get(turn)! < plan.threshold) regret++;
    }
  }

  shadowTimes.sort((a, b) => a - b);
  const spanDays =
    shadowTimes.length < 2 ? 0 : (shadowTimes.at(-1)! - shadowTimes[0]!) / 86_400_000;
  const recommendation: ExtractPrefilterReport["recommendation"] =
    regret > 0
      ? "lower_threshold"
      : evaluated > 0 && spanDays >= MIN_SHADOW_DAYS
        ? "enforce_possible"
        : "stay_in_shadow";

  return {
    since: opts.since ?? null,
    threshold: EXTRACT_PREFILTER_DROP_BELOW,
    plans: counted,
    scored_turns: scored,
    dropped_turns: dropped,
    drop_share_turns: share(dropped, scored),
    scored_chars: scoredChars,
    dropped_chars: droppedChars,
    drop_share_chars: share(droppedChars, scoredChars),
    skippable_plans: skippable,
    skip_share: share(skippable, counted),
    cited_items: cited,
    evaluated_items: evaluated,
    regret_items: regret,
    regret_share: share(regret, evaluated),
    shadow_span_days: Math.round(spanDays * 10) / 10,
    recommendation,
  };
}

function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

export function renderExtractPrefilterReport(report: ExtractPrefilterReport): string {
  const lines = [
    `extract_prefilter: ${report.plans} plan(s), threshold ${report.threshold}` +
      (report.since !== null ? ` since ${report.since}` : ""),
    `  drop share: ${pct(report.drop_share_turns)} of ${report.scored_turns} scored turn(s), ` +
      `${pct(report.drop_share_chars)} of characters`,
    `  skip share: ${pct(report.skip_share)} (${report.skippable_plans} plan(s) with every turn below)`,
    `  regret: ${report.regret_items} of ${report.evaluated_items} evaluated item(s) ` +
      `(${report.cited_items} cited a turn); shadow span ${report.shadow_span_days} day(s)`,
  ];
  const advice: Record<ExtractPrefilterReport["recommendation"], string> = {
    stay_in_shadow: "stay in shadow: not enough shadow evidence yet (a week with zero regret)",
    enforce_possible: "enforce possible: zero regret over at least a week of shadow sessions",
    lower_threshold:
      "lower the threshold or stay in shadow: some accepted items came from dropped turns",
  };
  lines.push(`  recommendation: ${advice[report.recommendation]}`);
  return lines.join("\n");
}
