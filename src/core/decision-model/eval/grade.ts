/**
 * The graded eval runner behind the preregistered decision-model specs
 * (cycle 20261020, card t_4e1681b3, task C2) - in the
 * `runRerankEvalGate` mold.
 *
 * Before anything is sent, the runner verifies the preregistration: the
 * spec's fixture must still hash to the frozen fixture hash and derive
 * exactly the frozen dev/counted membership (`verifyEvalTake`). It then
 * runs one decision request per take item - one `runDecision` per item,
 * with `recordOrigin: "eval"` so the calls count toward the daily cost
 * gate but stay out of the rerank shadow agreement - scores each answer
 * with the deterministic canonical scorer (an external judge, when one
 * exists, is advisory and never moves the metric), and caches the
 * verdicts as `decision_model_eval_grade` records stamped with the spec
 * hash and the correlated per-item call ids.
 *
 * Scoring, frozen with the spec grammar:
 *   - `rerank`: the enforced reorder's own semantics (movable slots
 *     filled by relevance probability, ties by index, unanswered
 *     candidates pinned at their heuristic index). The verdict per item
 *     is top-1 relevance. Baseline: the input order's top-1.
 *   - `recall_inject`: regret - a gold-useful note whose `helps`
 *     probability falls below the pinned `note_min` floor would be
 *     dropped in `enforce`. The verdict per item is regret-freeness.
 *     Baseline: the deterministic path drops nothing, so regret 0.
 *
 * The verdict is the preregistered three-arm rule: promote only when the
 * counted error meets the spec's ceiling, does not regress against the
 * baseline, and the counted n is met; a short counted n is its own arm
 * (`not_enough_evidence`), never a pass.
 */

import type { DecisionModelUse, DecisionProvider } from "../contract.ts";
import type { ResolvedDecisionModelConfig } from "../config-types.ts";
import {
  decisionEvalSpecFor,
  decisionEvalSpecHash,
  type DecisionEvalSpec,
  type DecisionEvalVerdict,
} from "../eval-spec.ts";
import { RECALL_INJECT_QUESTIONS, RERANK_QUESTIONS } from "../questions.ts";
import { emitDecisionModelEvalGrade, listDecisionModelCalls } from "../record.ts";
import { runDecision } from "../run.ts";
import { clip } from "../state.ts";
import { loadDecisionEvalFixture, verifyEvalTake, type DecisionEvalItem } from "./take.ts";

type ItemAnswers = Readonly<
  Record<string, { readonly valid: boolean; readonly value: number | string }>
>;

/** One take item's scoring outcome. */
interface ItemOutcome {
  readonly id: string;
  readonly split: "dev" | "counted";
  /** No usable answer arrived: the item shrinks n instead of counting as a miss. */
  readonly degraded: boolean;
  /** Scorer verdict (top-1 relevance / regret-freeness); false when degraded. */
  readonly verdict: boolean;
  /** The deterministic baseline's verdict on the same item. */
  readonly baseline: boolean;
}

export interface DecisionEvalRunResult {
  readonly use: DecisionModelUse;
  readonly profile: string | null;
  readonly seed: string;
  readonly spec_hash: string;
  readonly fixture_hash: string;
  readonly metric: string;
  readonly ceiling: number;
  readonly min_counted: number;
  readonly dev: { readonly n: number; readonly error: number | null };
  readonly counted: { readonly n: number; readonly error: number | null };
  readonly degraded_n: number;
  readonly baseline_error: number | null;
  readonly verdict: DecisionEvalVerdict;
  readonly counted_ids: ReadonlyArray<string>;
  readonly verdicts: Readonly<Record<string, boolean>>;
  readonly call_ids: ReadonlyArray<string>;
  readonly grade_record_id: string | null;
}

export interface DecisionEvalRunOptions {
  /** The resolved decision-model config; must be `active` to send anything. */
  readonly config: ResolvedDecisionModelConfig;
  /** Injected provider (tests). Defaults to the configured adapter. */
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  /**
   * The spec to run. Defaults to the registry entry for the use; an
   * explicit spec must still verify against the same fixture.
   */
  readonly spec?: DecisionEvalSpec;
}

function errorRate(fails: number, n: number): number | null {
  return n === 0 ? null : fails / n;
}

/**
 * The enforced rerank order's top index - `decisionRerankOrder` at floor
 * 0: movable slots fill from the score-sorted candidates (ties by
 * index), an unanswered candidate at index 0 is pinned there.
 */
function rerankTopIndex(probs: ReadonlyArray<number | null>): number | null {
  if (probs[0] === null) return 0;
  let best = -1;
  let bestP = -1;
  probs.forEach((p, i) => {
    if (p !== null && p > bestP) {
      best = i;
      bestP = p;
    }
  });
  return best < 0 ? null : best;
}

/** Score one rerank item: top-1 relevance after the enforced reorder. */
function scoreRerank(
  item: Extract<DecisionEvalItem, { kind: "rerank" }>,
  answers: ItemAnswers,
): { verdict: boolean; baseline: boolean; degraded: boolean } {
  const probs = item.candidates.map((_, k) => {
    const a = answers[RERANK_QUESTIONS.relevanceId(k)];
    return a?.valid === true && typeof a.value === "number" ? a.value : null;
  });
  const top = rerankTopIndex(probs);
  if (top === null) {
    return { verdict: false, baseline: item.candidates[0]!.relevant, degraded: true };
  }
  return {
    verdict: item.candidates[top]!.relevant,
    baseline: item.candidates[0]!.relevant,
    degraded: false,
  };
}

/** Score one recall_inject item: regret-freeness against the pinned floor. */
function scoreRecall(
  item: Extract<DecisionEvalItem, { kind: "recall_inject" }>,
  answers: ItemAnswers,
): { verdict: boolean; baseline: boolean; degraded: boolean } {
  // The deterministic baseline drops nothing: its regret is zero by
  // construction, which is exactly the bar the decision arm must meet.
  for (const [k, note] of item.notes.entries()) {
    if (!note.useful) continue;
    const a = answers[RECALL_INJECT_QUESTIONS.helpsId(k)];
    if (a?.valid !== true || typeof a.value !== "number") {
      return { verdict: false, baseline: true, degraded: true };
    }
    if (a.value < RECALL_INJECT_QUESTIONS.noteMin) {
      return { verdict: false, baseline: true, degraded: false };
    }
  }
  return { verdict: true, baseline: true, degraded: false };
}

/**
 * Run the preregistered eval for `use`. Sends exactly one request per
 * take item, after verifying the preregistration, and caches the verdict
 * set as a grade record. Never throws on model failures - degraded items
 * shrink the counted n; throws on a broken preregistration or an
 * inactive config.
 */
export async function runDecisionModelEval(
  use: DecisionModelUse,
  opts: DecisionEvalRunOptions,
): Promise<DecisionEvalRunResult> {
  const spec = opts.spec ?? decisionEvalSpecFor(use);
  if (spec === null || spec === undefined) {
    throw new Error(`decision-model eval: no preregistered spec for use '${use}'`);
  }
  if (spec.use !== use) {
    throw new Error(`decision-model eval: spec names use '${spec.use}', not '${use}'`);
  }
  const cfg = opts.config;
  if (cfg.status !== "active") {
    throw new Error(
      `decision-model eval: the config is '${cfg.status}', not active; ` +
        "run `o2b decision-model check` for what is missing",
    );
  }
  const { fixture, contentHash } = loadDecisionEvalFixture(spec.fixture, spec.use);
  verifyEvalTake(spec, fixture, contentHash);
  const countedSet = new Set(spec.receipt.counted);

  // Eval requests are real spend but not shadow data: the rerank eval
  // gate's own stance, kept here.
  const evalCfg: ResolvedDecisionModelConfig = { ...cfg, recordOrigin: "eval" };
  const outcomes: ItemOutcome[] = [];

  for (const item of fixture.items) {
    const built =
      item.kind === "rerank"
        ? {
            kind: "ok" as const,
            state: {
              query: item.query,
              passages: Object.fromEntries(
                item.candidates.map((c, k) => [
                  `${RERANK_QUESTIONS.prefix}${k}`,
                  clip(`${c.title}\n${c.text}`, RERANK_QUESTIONS.clipChars),
                ]),
              ),
            },
            candidateCount: item.candidates.length,
            context: null,
          }
        : {
            kind: "ok" as const,
            state: {
              prompt: item.prompt,
              notes: Object.fromEntries(
                item.notes.map((n, k) => [
                  `${RECALL_INJECT_QUESTIONS.prefix}${k}`,
                  clip(`${n.title}\n${n.text}`, RECALL_INJECT_QUESTIONS.clipChars),
                ]),
              ),
            },
            candidateCount: item.notes.length,
            context: null,
          };
    const questions =
      item.kind === "rerank"
        ? Object.fromEntries(
            item.candidates.map((_, k) => [
              RERANK_QUESTIONS.relevanceId(k),
              RERANK_QUESTIONS.relevance(k),
            ]),
          )
        : Object.fromEntries(
            item.notes.map((_, k) => [
              RECALL_INJECT_QUESTIONS.helpsId(k),
              RECALL_INJECT_QUESTIONS.helps(k),
            ]),
          );
    const result = await runDecision<null>(
      use,
      () => built,
      () => questions,
      {
        config: evalCfg,
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        // The eval measures what `enforce` would do, whatever the operator
        // configured: a shadow arm would measure nothing.
        modeOverride: "enforce",
        ...(opts.now !== undefined ? { now: () => opts.now! } : {}),
        recordDetails: () => ({ item_id: item.id }),
      },
    );
    const scored =
      result.status === "ok"
        ? item.kind === "rerank"
          ? scoreRerank(item, result.response.answers)
          : scoreRecall(item, result.response.answers)
        : {
            verdict: false,
            baseline: item.kind === "rerank" ? item.candidates[0]!.relevant : true,
            degraded: true,
          };
    outcomes.push({
      id: item.id,
      split: countedSet.has(item.id) ? "counted" : "dev",
      degraded: scored.degraded,
      verdict: scored.verdict,
      baseline: scored.baseline,
    });
  }

  const aggregate = (
    split: "dev" | "counted",
  ): { n: number; error: number | null; baselineFails: number } => {
    const items = outcomes.filter((o) => o.split === split && !o.degraded);
    const fails = items.filter((o) => !o.verdict).length;
    const baselineFails = items.filter((o) => !o.baseline).length;
    return { n: items.length, error: errorRate(fails, items.length), baselineFails };
  };
  const countedAgg = aggregate("counted");
  const devAgg = aggregate("dev");
  const countedError = countedAgg.error;
  const baselineError = errorRate(countedAgg.baselineFails, countedAgg.n);
  const verdict: DecisionEvalVerdict =
    countedAgg.n < spec.min_counted
      ? "not_enough_evidence"
      : countedError !== null &&
          baselineError !== null &&
          countedError <= spec.ceiling &&
          countedError <= baselineError
        ? "promote"
        : "hold";
  const degradedN = outcomes.filter((o) => o.degraded).length;
  const verdictsById = Object.fromEntries(
    outcomes.filter((o) => o.split === "counted").map((o) => [o.id, o.verdict]),
  );
  // Correlate the grade with the real recorded requests: one scan over
  // this run's eval-origin calls, matched by the item ids they carry.
  const callIds =
    cfg.vault === null
      ? []
      : listDecisionModelCalls(cfg.vault)
          .filter(
            (r) =>
              r.payload["origin"] === "eval" &&
              typeof r.payload["item_id"] === "string" &&
              outcomes.some((o) => o.id === r.payload["item_id"]),
          )
          .map((r) => r.id);

  const record = emitDecisionModelEvalGrade(cfg.vault, {
    profile: cfg.thresholdProfile ?? null,
    use,
    specHash: decisionEvalSpecHash(spec),
    fixtureHash: spec.fixture_hash,
    seed: spec.seed,
    metric: spec.metric,
    ceiling: spec.ceiling,
    minCounted: spec.min_counted,
    countedN: countedAgg.n,
    countedError,
    baselineError,
    devError: devAgg.error,
    verdict,
    devIds: [...spec.receipt.dev],
    countedIds: [...spec.receipt.counted],
    verdicts: verdictsById,
    callIds,
    ...(opts.now !== undefined ? { createdAt: opts.now.toISOString() } : {}),
  });

  return {
    use,
    profile: cfg.thresholdProfile ?? null,
    seed: spec.seed,
    spec_hash: decisionEvalSpecHash(spec),
    fixture_hash: spec.fixture_hash,
    metric: spec.metric,
    ceiling: spec.ceiling,
    min_counted: spec.min_counted,
    dev: { n: devAgg.n, error: devAgg.error },
    counted: { n: countedAgg.n, error: countedError },
    degraded_n: degradedN,
    baseline_error: baselineError,
    verdict,
    counted_ids: [...spec.receipt.counted],
    verdicts: verdictsById,
    call_ids: callIds,
    grade_record_id: record?.id ?? null,
  };
}
