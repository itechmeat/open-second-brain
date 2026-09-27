/**
 * `o2b decision-model report --use skills` metrics (issue #213, Part 3).
 *
 * One skill selection writes one `decision_model_call` record per stage,
 * joined by `correlation_id`; the record with `final: true` carries both
 * offered lists (`deterministic_offered`, `decision_offered`) and the
 * `offer_id` that was actually returned. Agents cite that id on
 * `get_skill`, so each `skill_invoked` record joins back to one selection.
 *
 *   - Offer-hit rate: over selections where at least one skill was
 *     invoked from the returned offer, the share where an invoked skill is
 *     in the decision set, next to the same share for the BM25 set.
 *   - Needless-offer rate: over all compared selections, the share that
 *     offered something (non-empty set) while nothing was invoked. An
 *     empty decision set ("offer nothing") is never needless.
 *
 * In shadow the returned offer is the BM25 one, so invocations can only
 * come from it; the decision hit rate then measures how often the model
 * kept the skill the agent went on to use. `enforce` is recommended only
 * when the decision hit rate does not drop and needless offers fall.
 */

import { joinSkillInvocationsToOffers } from "../../brain/skill-usage.ts";
import type { ContinuityRecord } from "../../brain/continuity/types.ts";
import { listDecisionModelCalls } from "../record.ts";

export interface SkillsSelectionRates {
  readonly offer_hit_rate: number | null;
  readonly needless_offer_rate: number | null;
}

export interface SkillsDecisionReport {
  /** Selections with a final record carrying a decision set. */
  readonly compared: number;
  /** Selections that fell back to BM25 (degrade, invalid or not confident). */
  readonly fallback: number;
  /** Compared selections with at least one invocation of the returned offer. */
  readonly invoked: number;
  readonly decision: SkillsSelectionRates;
  readonly bm25: SkillsSelectionRates;
  /** True only on invocation evidence: hits do not drop and needless offers fall. */
  readonly enforce_recommended: boolean;
}

function names(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : null;
}

/** The final record of each selection (the last one flagged `final`). */
function finalRecords(records: ReadonlyArray<ContinuityRecord>): ContinuityRecord[] {
  const byCorrelation = new Map<string, ContinuityRecord>();
  for (const record of records) {
    const p = record.payload;
    if (p["use"] !== "skills" || p["origin"] !== undefined || p["final"] !== true) continue;
    const id = p["correlation_id"];
    if (typeof id !== "string") continue;
    byCorrelation.set(id, record);
  }
  return [...byCorrelation.values()];
}

function rate(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

export function buildSkillsDecisionReport(
  vault: string,
  opts: { readonly since?: string } = {},
): SkillsDecisionReport {
  const finals = finalRecords(listDecisionModelCalls(vault, opts.since));
  const invokedByOffer = new Map<string, Set<string>>();
  for (const offer of joinSkillInvocationsToOffers(vault).offers) {
    invokedByOffer.set(offer.offerId, new Set(offer.invocations.map((i) => i.skill)));
  }
  let compared = 0;
  let fallback = 0;
  let invoked = 0;
  let decisionHits = 0;
  let bm25Hits = 0;
  let decisionNeedless = 0;
  let bm25Needless = 0;
  for (const record of finals) {
    const p = record.payload;
    const bm25 = names(p["deterministic_offered"]);
    const decision = names(p["decision_offered"]);
    if (bm25 === null || decision === null) {
      fallback++;
      continue;
    }
    compared++;
    const offerId = typeof p["offer_id"] === "string" ? p["offer_id"] : null;
    const used = offerId !== null ? invokedByOffer.get(offerId) : undefined;
    if (used !== undefined && used.size > 0) {
      invoked++;
      if (decision.some((n) => used.has(n))) decisionHits++;
      if (bm25.some((n) => used.has(n))) bm25Hits++;
    } else {
      if (decision.length > 0) decisionNeedless++;
      if (bm25.length > 0) bm25Needless++;
    }
  }
  const decisionRates = {
    offer_hit_rate: rate(decisionHits, invoked),
    needless_offer_rate: rate(decisionNeedless, compared),
  };
  const bm25Rates = {
    offer_hit_rate: rate(bm25Hits, invoked),
    needless_offer_rate: rate(bm25Needless, compared),
  };
  return {
    compared,
    fallback,
    invoked,
    decision: decisionRates,
    bm25: bm25Rates,
    enforce_recommended: invoked > 0 && decisionHits >= bm25Hits && decisionNeedless < bm25Needless,
  };
}

function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

export function renderSkillsDecisionReport(report: SkillsDecisionReport): string {
  return [
    `    skills: ${report.compared} compared selection(s), ${report.fallback} fallback, ` +
      `${report.invoked} with an invoked skill`,
    `    offer-hit rate: decision ${pct(report.decision.offer_hit_rate)}, ` +
      `BM25 ${pct(report.bm25.offer_hit_rate)}`,
    `    needless-offer rate: decision ${pct(report.decision.needless_offer_rate)}, ` +
      `BM25 ${pct(report.bm25.needless_offer_rate)}`,
    `    enforce recommended: ${report.enforce_recommended ? "yes" : "no"}`,
  ].join("\n");
}
