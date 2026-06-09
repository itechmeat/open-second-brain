/**
 * Contradiction reconcile outcomes (dream phase F3).
 *
 * Extracted from dream.ts. Classifies every contradiction topic the
 * plan flagged and decides auto-resolution vs operator-facing open
 * question. Pure; emits nothing.
 */

import {
  resolveContradiction,
  type ContradictionInput,
  type ReconcileSignal,
} from "./reconcile-domains.ts";
import {
  filterWithinWindow,
  type PlanState,
  type ScanResult,
  type SignalRecord,
} from "./dream-plan.ts";
import { BRAIN_SIGNAL_SIGN, type BrainConfig, type DreamOpenQuestion } from "./types.ts";

/** Project a scanned signal onto the minimal reconcile view. */
function toReconcileSignal(r: SignalRecord): ReconcileSignal {
  return {
    created_at: r.signal.created_at,
    ...(r.signal.recorded_at ? { recorded_at: r.signal.recorded_at } : {}),
    ...(r.signal.source ? { source: r.signal.source } : {}),
  };
}

// ----- Reconcile (F3) ------------------------------------------------------

export interface ReconcileAutoResolved {
  readonly topic: string;
  readonly domain: "source-freshness";
  readonly winner_sign: "positive" | "negative";
  readonly margin_days: number;
}

export interface ReconcileOutcomes {
  readonly openQuestions: DreamOpenQuestion[];
  readonly autoResolved: ReconcileAutoResolved[];
}

/**
 * Classify every contradiction topic the plan flagged into a domain and
 * decide its outcome. Source-freshness contradictions where the fresher
 * side leads by at least half the contradiction window auto-resolve
 * (recorded only - never a sub-threshold mutation); the rest become
 * operator-facing open questions. Pure; emits nothing.
 */
export function buildReconcileOutcomes(
  scan: ScanResult,
  plan: PlanState,
  cfg: BrainConfig,
  now: Date,
): ReconcileOutcomes {
  const openQuestions: DreamOpenQuestion[] = [];
  const autoResolved: ReconcileAutoResolved[] = [];
  if (plan.contradictionTopics.size === 0) return { openQuestions, autoResolved };

  const windowDays = cfg.dream.contradiction_window_days;
  // Freshness must be decisive WITHIN the contradiction window, so the
  // margin is half the window (a gap larger than the window would have
  // excluded the older signal from the contradiction in the first place).
  const freshnessMarginDays = Math.max(1, Math.ceil(windowDays / 2));

  const byTopic = new Map<string, SignalRecord[]>();
  for (const rec of scan.signals) {
    const arr = byTopic.get(rec.signal.topic);
    if (arr) arr.push(rec);
    else byTopic.set(rec.signal.topic, [rec]);
  }

  for (const topic of plan.contradictionTopics) {
    const sigs = filterWithinWindow(byTopic.get(topic) ?? [], windowDays, now);
    const positives = sigs
      .filter((s) => s.signal.signal === BRAIN_SIGNAL_SIGN.positive)
      .map(toReconcileSignal);
    const negatives = sigs
      .filter((s) => s.signal.signal === BRAIN_SIGNAL_SIGN.negative)
      .map(toReconcileSignal);
    const scope = sigs.find((s) => s.signal.scope)?.signal.scope;
    const input: ContradictionInput = {
      topic,
      ...(scope ? { scope } : {}),
      positives,
      negatives,
    };
    const outcome = resolveContradiction(input, { now, freshnessMarginDays });
    if (outcome.kind === "auto-resolved") {
      autoResolved.push({
        topic,
        domain: outcome.domain,
        winner_sign: outcome.winner_sign,
        margin_days: outcome.margin_days,
      });
    } else {
      openQuestions.push(outcome.question);
    }
  }
  return { openQuestions, autoResolved };
}
