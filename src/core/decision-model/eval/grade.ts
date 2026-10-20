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
 *     dropped in `enforce`, and an `inject_any` answer below the pinned
 *     `any_min` would withhold the whole brief - a regret only when the
 *     item carries at least one gold-useful note, since withholding a
 *     brief over notes none of which is useful loses nothing. The
 *     verdict per item is the enforced filter's own outcome
 *     (`recallInjectFilterOutcome`). Baseline: the deterministic path
 *     drops nothing, so regret 0.
 *
 * The verdict is the preregistered three-arm rule: promote only when the
 * counted error meets the spec's ceiling, does not regress against the
 * baseline, and the counted n is met; a short counted n is its own arm
 * (`not_enough_evidence`), never a pass.
 *
 * On a `promote` verdict - and only then, and only for a named threshold
 * profile, only when a grade record exists to review the mark against,
 * and only when the day's recorded spend stayed under the daily cost
 * gate - the runner writes the machine-side tuning mark
 * (`eval/mark.ts`) under the caller-supplied state root, making it the
 * one code path that can mark a profile tuned. The vault's grade record
 * is the review evidence; the mark is the gate input.
 *
 * The gate also lets go: a COMPLETED run whose verdict is not `promote`
 * (a `hold`, or `not_enough_evidence`) retracts the mark that the same
 * profile, use and spec earned earlier, so a later failing measurement
 * never leaves an older promote armed. A refused or errored run - the
 * throws above - retracts nothing: it measured nothing.
 */

import { randomUUID } from "node:crypto";

import type { DecisionModelUse, DecisionProvider } from "../contract.ts";
import type { ResolvedDecisionModelConfig } from "../config-types.ts";
import {
  decisionEvalSpecFor,
  decisionEvalSpecHash,
  type DecisionEvalSpec,
  type DecisionEvalVerdict,
} from "../eval-spec.ts";
import { RECALL_INJECT_QUESTIONS, RERANK_QUESTIONS } from "../questions.ts";
import { recallInjectFilterOutcome } from "../../brain/recall-inject.ts";
import { emitDecisionModelEvalGrade, listDecisionModelCalls, todaySpendUsd } from "../record.ts";
import { runDecision } from "../run.ts";
import { clip } from "../state.ts";
import type { PlatformDirsEnv } from "../../platform-dirs.ts";
import {
  decisionModelBaseUrlHash,
  decisionModelTuningMarkPath,
  retractTuningMark,
  writeTuningMark,
  type DecisionTuningMark,
} from "./mark.ts";
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
  /** True exactly when a `promote` verdict wrote the machine-side mark. */
  readonly mark_written: boolean;
  /**
   * True exactly when a completed non-promote verdict deleted the
   * matching earlier mark for this (profile, use, spec) - the gate has
   * gone back to shadow.
   */
  readonly mark_retracted: boolean;
  /** Why no mark was written, when one was not; null on a written mark. */
  readonly mark_note: string | null;
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
  /**
   * Where a `promote` verdict writes the machine-side tuning mark - and
   * a completed non-promote verdict retracts one: the eval CLI passes
   * the running process's platform dirs. Absent or null (every test, and
   * any caller measuring without deciding) disables mark writing and
   * retraction alike - a run that only measures leaves no gate input
   * behind and changes none.
   */
  readonly markSource?: PlatformDirsEnv | null;
}

function errorRate(fails: number, n: number): number | null {
  return n === 0 ? null : fails / n;
}

/**
 * Whether the vault's recorded spend for `now`'s UTC day - the whole
 * day's total, this run's records included - has reached `gate`. A day
 * total that cannot be read counts as over the gate (the gate's own
 * stance on an unreadable log), so a broken call log refuses the mark
 * by name instead of throwing past the measurement and the grade record
 * the run has already written.
 */
function spendAtOrOverGate(vault: string, now: Date, gate: number): boolean {
  try {
    return todaySpendUsd(vault, now) >= gate;
  } catch {
    return true;
  }
}

/**
 * The enforced rerank order's top index - `decisionRerankOrder` at floor
 * 0: movable slots fill from the score-sorted candidates (ties by
 * index), an unanswered candidate at index 0 is pinned there. Null only
 * when no usable answer arrived at all, so the item degrades instead of
 * silently matching the input-order baseline.
 */
function rerankTopIndex(probs: ReadonlyArray<number | null>): number | null {
  if (probs.every((p) => p === null)) return null;
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

/**
 * Score one recall_inject item: regret-freeness against the pinned floor.
 * Exported for the regret-rule pins: the committed fixture grammar
 * requires every item to carry a useful note, so the no-useful-note
 * half of the rule is only reachable through a direct call.
 */
export function scoreRecall(
  item: Extract<DecisionEvalItem, { kind: "recall_inject" }>,
  answers: ItemAnswers,
): { verdict: boolean; baseline: boolean; degraded: boolean } {
  // The deterministic baseline drops nothing: its regret is zero by
  // construction, which is exactly the bar the decision arm must meet.
  // Canonical scoring: every answer is collected before anything is
  // decided, so an early slot without a usable answer cannot mask a
  // later slot's valid below-floor answer - the note enforce really
  // would drop. The verdict itself is the enforced filter's own outcome
  // (`recallInjectFilterOutcome`), including its inject_any abstain arm:
  // the eval sends every note, the only situation where that arm fires.
  const helps = item.notes.map((_, k) => {
    const a = answers[RECALL_INJECT_QUESTIONS.helpsId(k)];
    return a?.valid === true && typeof a.value === "number" ? a.value : null;
  });
  const any = answers[RECALL_INJECT_QUESTIONS.injectAnyId];
  const injectAny = any?.valid === true && typeof any.value === "number" ? any.value : null;
  const { abstain, keep } = recallInjectFilterOutcome(
    helps,
    item.notes.map(() => true),
    injectAny,
  );
  const droppedUseful = item.notes.some((n, k) => n.useful && keep[k] === false);
  // Abstaining loses nothing on an item none of whose notes is
  // gold-useful - the brief it withholds carries no note worth having -
  // so only an abstain over a gold-useful note is a counted failure
  // (regret is losing a gold-useful note, nothing else).
  const hasUseful = item.notes.some((n) => n.useful);
  if (droppedUseful || (abstain && hasUseful)) {
    return { verdict: false, baseline: true, degraded: false };
  }
  const unansweredUseful = item.notes.some((n, k) => n.useful && helps[k] === null);
  if (unansweredUseful) return { verdict: false, baseline: true, degraded: true };
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
  // Run-scoped correlation token, stamped into every call record this
  // run writes: a vault that has seen earlier eval runs holds eval-origin
  // records with the same item ids, and the grade's call_ids must list
  // only this grading run's requests.
  const evalRunToken = randomUUID();
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
        : Object.fromEntries([
            ...item.notes.map((_, k) => [
              RECALL_INJECT_QUESTIONS.helpsId(k),
              RECALL_INJECT_QUESTIONS.helps(k),
            ]),
            // The one question over all notes the enforce path asks too;
            // its answer drives the abstain arm the metric grades.
            [RECALL_INJECT_QUESTIONS.injectAnyId, RECALL_INJECT_QUESTIONS.injectAny()],
          ]);
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
        recordDetails: () => ({ item_id: item.id, eval_run: evalRunToken }),
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
  // Correlate the grade with the real recorded requests: only this run's
  // eval-origin calls, matched by the run token they carry (item ids
  // alone would also match every earlier run on the same vault).
  const callIds =
    cfg.vault === null
      ? []
      : listDecisionModelCalls(cfg.vault)
          .filter(
            (r) =>
              r.payload["origin"] === "eval" &&
              r.payload["eval_run"] === evalRunToken &&
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

  // The mark is the gate input and this is its only writer: a promote
  // verdict, a named profile, a state root to write under, a grade
  // record to review it against, and a day's recorded spend that stayed
  // under the daily cost gate. A failed write - or a day total that
  // cannot be read - is reported, never thrown: the measurement already
  // happened and the spend is already counted. The gate also lets go: a
  // completed non-promote measurement retracts the matching earlier
  // mark, so a use that missed its bar never keeps an older promote
  // armed while the CLI text suggests the gate is off.
  const profile = cfg.thresholdProfile ?? null;
  let markWritten = false;
  let markRetracted = false;
  let markNote: string | null = null;
  const now = opts.now ?? new Date();
  if (verdict !== "promote") {
    // A completed run - the refusals above throw, so reaching this line
    // is completing - whose verdict is not promote withdraws the mark
    // this (profile, use, spec) earned earlier. The same guard rails as
    // the write apply as far as they can: without a profile or a state
    // root there is nothing to retract, and a mark earned by another
    // spec is not this run's to delete.
    try {
      markRetracted = retractTuningMark(opts.markSource, profile, use, decisionEvalSpecHash(spec));
    } catch (err) {
      markNote = `the previous tuning mark could not be retracted: ${(err as Error).message}`;
    }
    if (markNote === null) {
      markNote = markRetracted
        ? `verdict is '${verdict}'; the earlier tuning mark was retracted, ` +
          "so the use runs shadow until a promote measures it again"
        : `verdict is '${verdict}'; only a promote writes a tuning mark`;
    }
  } else if (profile === null) {
    markNote =
      "the config carries no threshold profile, so there is no (profile, use) pair to mark";
  } else if (opts.markSource === null || opts.markSource === undefined) {
    markNote = "no state root was provided, so the run measured without marking";
  } else if (record === null) {
    // The vault's grade records are the review evidence a reviewer
    // audits the mark against; without one the promote is refused by
    // name instead of arming enforce on nothing.
    markNote =
      "no grade record was written (no vault configured, or the record write failed), " +
      "so the promote has no review evidence to mark";
  } else if (
    cfg.vault !== null &&
    cfg.dailyCostGateUsd > 0 &&
    spendAtOrOverGate(cfg.vault, now, cfg.dailyCostGateUsd)
  ) {
    markNote =
      `today's recorded spend reached the daily cost gate (${cfg.dailyCostGateUsd} USD) ` +
      `or could not be read; the mark waits for a run that stays under it`;
  } else {
    const mark: DecisionTuningMark = {
      profile,
      use,
      spec_hash: decisionEvalSpecHash(spec),
      fixture_hash: spec.fixture_hash,
      thresholds: spec.thresholds,
      metric: spec.metric,
      counted_n: countedAgg.n,
      counted_error: countedError,
      baseline_error: baselineError,
      verdict: "promote",
      created_at: now.toISOString(),
      // The endpoint binding: this config - and only this config, until
      // the operator changes it - may arm enforce off the mark. A null
      // provider or model cannot occur on an active config, but an empty
      // string recorded here would simply never match a later resolution.
      provider: cfg.provider ?? "",
      model: cfg.model ?? "",
      base_url_hash: decisionModelBaseUrlHash(cfg.baseUrl),
    };
    try {
      writeTuningMark(decisionModelTuningMarkPath(opts.markSource, profile, use), mark);
      markWritten = true;
    } catch (err) {
      markNote = `the tuning mark could not be written: ${(err as Error).message}`;
    }
  }

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
    mark_written: markWritten,
    mark_retracted: markRetracted,
    mark_note: markNote,
  };
}
