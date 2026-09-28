/**
 * Pair verdicts (issue #213, Part 5): one `choice` question per proposed
 * pair, used by the advisory `dedup` and `tension` uses.
 *
 * The deterministic detectors (embedding cosine, Jaccard, the negation
 * lexicon) propose pairs; this helper asks the decision model for a
 * verdict on each. The state carries each pair as two named fields,
 * `pairs.A<i>` and `pairs.B<i>`, clipped, and the question `pair_<i>`
 * chooses one of the use's options.
 *
 * Rules:
 *   - a side whose page is private, unresolvable or unreadable, or whose
 *     text carries part of a `<private>` region, is never sent, and its
 *     pair gets no verdict;
 *   - pairs are packed into as few requests as fit `max_state_tokens`
 *     (state and questions together), at most
 *     `PAIR_VERDICT_LIMITS.maxPairsPerRequest` per request and
 *     `PAIR_VERDICT_LIMITS.maxRequests` requests per call; a pair that
 *     does not fit gets no verdict;
 *   - every request goes through `runDecision`, so each writes one
 *     `decision_model_call` record carrying the pair identifiers and the
 *     verdicts (never the texts);
 *   - a degraded request leaves its pairs without a verdict and stops the
 *     remaining requests;
 *   - an invalid answer leaves its pair without a verdict.
 *
 * Nothing here writes to the vault. What a caller does with a verdict is
 * limited to annotating and, in enforce, reordering its own listing.
 */

import { randomUUID } from "node:crypto";

import { decisionModelModeFor, type ResolvedDecisionModelConfig } from "./config.ts";
import type {
  DecisionChoiceQuestion,
  DecisionModelMode,
  DecisionModelUse,
  DecisionProvider,
  DecisionResponse,
} from "./contract.ts";
import { PAIR_VERDICT_LIMITS } from "./questions.ts";
import { runDecision } from "./run.ts";
import { buildCandidateState, estimateTokens, type StateCandidate } from "./state.ts";

/** One advisory verdict, as the tool and CLI outputs carry it. */
export interface PairVerdict {
  readonly verdict: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly model: string;
  readonly calibrated: boolean;
}

export interface VerdictPairInput {
  /** Pair identifier for the accounting record (finding id, tension slug, ...). */
  readonly id: string;
  /** Identifiers of the two sides for the record (preference or entity ids, subjects). */
  readonly a: string;
  readonly b: string;
  readonly sideA: StateCandidate;
  readonly sideB: StateCandidate;
}

export interface PairVerdictSpec {
  readonly use: Extract<DecisionModelUse, "dedup" | "tension">;
  /** What the pairs are, for the record (`preference`, `entity`, `tension`). */
  readonly pairKind: string;
  readonly options: ReadonlyArray<string>;
  readonly clipChars: number;
  readonly question: (i: number) => DecisionChoiceQuestion;
}

export interface PairVerdictRunOptions {
  readonly config: ResolvedDecisionModelConfig | null | undefined;
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type PairVerdictRun =
  | { readonly status: "off" }
  | {
      readonly status: "done";
      readonly mode: Exclude<DecisionModelMode, "off">;
      /** Aligned with the input pairs; null where no verdict exists. */
      readonly verdicts: ReadonlyArray<PairVerdict | null>;
      /** The first degrade reason, when a request degraded. */
      readonly degraded?: string;
    };

interface Prepared {
  readonly index: number;
  readonly a: string;
  readonly b: string;
}

interface Batch {
  readonly pairs: ReadonlyArray<Prepared>;
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: Readonly<Record<string, DecisionChoiceQuestion>>;
}

/** The clipped, stripped text of one side, or null when it may not leave. */
function sendableText(side: StateCandidate, clipChars: number): string | null {
  const built = buildCandidateState({
    candidates: [side],
    prefix: "X",
    clipChars,
    maxStateTokens: Number.POSITIVE_INFINITY,
    frame: (texts) => texts,
  });
  if (built.kind !== "ok") return null;
  const text = built.state["X0"];
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

function frameBatch(pairs: ReadonlyArray<Prepared>, spec: PairVerdictSpec): Batch {
  const fields: Record<string, string> = {};
  const questions: Record<string, DecisionChoiceQuestion> = {};
  pairs.forEach((pair, k) => {
    fields[`${PAIR_VERDICT_LIMITS.prefixA}${k}`] = pair.a;
    fields[`${PAIR_VERDICT_LIMITS.prefixB}${k}`] = pair.b;
    questions[PAIR_VERDICT_LIMITS.questionId(k)] = spec.question(k);
  });
  return { pairs, state: { pairs: fields }, questions };
}

function fits(batch: Batch, maxStateTokens: number): boolean {
  return estimateTokens({ state: batch.state, questions: batch.questions }) <= maxStateTokens;
}

/**
 * Pack the sendable pairs into batches. Returns the batches and how many
 * pairs were left out for budget reasons.
 */
function planPairBatches(
  prepared: ReadonlyArray<Prepared>,
  spec: PairVerdictSpec,
  maxStateTokens: number,
): { readonly batches: ReadonlyArray<Batch>; readonly unfit: number } {
  const batches: Batch[] = [];
  let unfit = 0;
  let current: Prepared[] = [];
  const flush = (): void => {
    if (current.length > 0) batches.push(frameBatch(current, spec));
    current = [];
  };
  for (const pair of prepared) {
    if (batches.length >= PAIR_VERDICT_LIMITS.maxRequests) {
      unfit++;
      continue;
    }
    const alone = frameBatch([pair], spec);
    if (!fits(alone, maxStateTokens)) {
      unfit++;
      continue;
    }
    const next = [...current, pair];
    if (next.length <= PAIR_VERDICT_LIMITS.maxPairsPerRequest) {
      if (fits(frameBatch(next, spec), maxStateTokens)) {
        current = next;
        continue;
      }
    }
    flush();
    if (batches.length >= PAIR_VERDICT_LIMITS.maxRequests) {
      unfit++;
      continue;
    }
    current = [pair];
  }
  if (batches.length < PAIR_VERDICT_LIMITS.maxRequests) flush();
  else unfit += current.length;
  return { batches, unfit };
}

function verdictOf(
  response: DecisionResponse,
  k: number,
  options: ReadonlyArray<string>,
): PairVerdict | null {
  const answer = response.answers[PAIR_VERDICT_LIMITS.questionId(k)];
  if (answer === undefined || !answer.valid || answer.type !== "choice") return null;
  if (typeof answer.value !== "string" || !options.includes(answer.value)) return null;
  const probabilities: Record<string, number> = {};
  for (const option of options) {
    const p = answer.probabilities?.[option];
    if (typeof p === "number" && Number.isFinite(p)) probabilities[option] = p;
  }
  return Object.freeze({
    verdict: answer.value,
    probabilities: Object.freeze(probabilities),
    model: response.model,
    calibrated: response.calibrated,
  });
}

/** The probability of the chosen verdict (its argmax), or 0 when absent. */
export function verdictProbability(v: PairVerdict): number {
  return v.probabilities[v.verdict] ?? 0;
}

/**
 * Ask for a verdict on every pair. With the use `off` (or no active
 * config) nothing is built, sent or recorded, and the result is `off`.
 */
export async function runPairVerdicts(
  pairs: ReadonlyArray<VerdictPairInput>,
  spec: PairVerdictSpec,
  opts: PairVerdictRunOptions,
): Promise<PairVerdictRun> {
  const cfg = opts.config;
  const configured = decisionModelModeFor(cfg, spec.use);
  if (configured === "off" || cfg === null || cfg === undefined) return { status: "off" };
  const mode: Exclude<DecisionModelMode, "off"> = configured;
  const correlationId = randomUUID();
  const verdicts: (PairVerdict | null)[] = pairs.map(() => null);

  const prepared: Prepared[] = [];
  let withheld = 0;
  pairs.forEach((pair, index) => {
    const a = sendableText(pair.sideA, spec.clipChars);
    const b = a === null ? null : sendableText(pair.sideB, spec.clipChars);
    if (a === null || b === null) {
      withheld++;
      return;
    }
    prepared.push({ index, a, b });
  });
  if (prepared.length === 0) return { status: "done", mode, verdicts };

  const { batches, unfit } = planPairBatches(prepared, spec, cfg.maxStateTokens);
  let degraded: string | undefined;
  for (let n = 0; n < batches.length; n++) {
    const batch = batches[n]!;
    // Sequential on purpose: a degraded request stops the remaining ones,
    // and each one is checked against the daily cost gate in turn.
    // oxlint-disable-next-line no-await-in-loop
    const result = await runDecision<Batch>(
      spec.use,
      () => ({
        kind: "ok",
        state: batch.state,
        candidateCount: batch.pairs.length,
        context: batch,
      }),
      () => batch.questions,
      {
        config: cfg,
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        recordDetails: (response) => ({
          pair_kind: spec.pairKind,
          correlation_id: correlationId,
          request_index: n,
          request_count: batches.length,
          withheld_count: withheld,
          budget_dropped_count: unfit,
          pairs: batch.pairs.map((p, k) => {
            const pair = pairs[p.index]!;
            const v = response === null ? null : verdictOf(response, k, spec.options);
            return {
              id: pair.id,
              a: pair.a,
              b: pair.b,
              verdict: v?.verdict ?? null,
              probability: v === null ? null : verdictProbability(v),
            };
          }),
        }),
      },
    );
    if (result.status === "off") return { status: "off" };
    if (result.status === "degraded") {
      degraded = result.reason;
      break;
    }
    if (result.status !== "ok") continue;
    batch.pairs.forEach((p, k) => {
      verdicts[p.index] = verdictOf(result.response, k, spec.options);
    });
  }
  return {
    status: "done",
    mode,
    verdicts,
    ...(degraded !== undefined ? { degraded } : {}),
  };
}

/** One listed item with its advisory annotation. */
export interface AnnotatedItem<T> {
  readonly item: T;
  readonly verdict: PairVerdict | null;
  readonly lowPriority: boolean;
}

/**
 * The enforce ordering: an item whose verdict is one of `lowPriority` at
 * or above `PAIR_VERDICT_LIMITS.lowPriorityMin` moves to the end of the
 * list, keeping the relative order on both sides. Nothing is removed.
 * In shadow the order and the items are unchanged and no verdict is
 * shown, so the output is byte-identical to the use being off.
 */
export function orderByVerdicts<T>(
  items: ReadonlyArray<T>,
  verdicts: ReadonlyArray<PairVerdict | null>,
  mode: Exclude<DecisionModelMode, "off">,
  lowPriority: ReadonlyArray<string>,
): ReadonlyArray<AnnotatedItem<T>> {
  const annotated = items.map((item, i) => {
    const verdict = mode === "enforce" ? (verdicts[i] ?? null) : null;
    const low =
      mode === "enforce" &&
      verdict !== null &&
      lowPriority.includes(verdict.verdict) &&
      verdictProbability(verdict) >= PAIR_VERDICT_LIMITS.lowPriorityMin;
    return { item, verdict, lowPriority: low };
  });
  if (mode !== "enforce") return annotated;
  return [...annotated.filter((a) => !a.lowPriority), ...annotated.filter((a) => a.lowPriority)];
}

/**
 * The advisory fields an annotated item gains in enforce: `decision_model`
 * when a verdict exists, and `decision_model_low_priority: true` when it
 * was moved to the end. Empty (the item unchanged) otherwise.
 */
export function verdictFields(a: AnnotatedItem<unknown>): Record<string, unknown> {
  if (a.verdict === null) return {};
  return {
    decision_model: {
      verdict: a.verdict.verdict,
      probabilities: a.verdict.probabilities,
      model: a.verdict.model,
      calibrated: a.verdict.calibrated,
    },
    ...(a.lowPriority ? { decision_model_low_priority: true } : {}),
  };
}

/** One human-readable line for a CLI listing, e.g. `decision model: different (p 0.950), low priority`. */
export function verdictLine(a: AnnotatedItem<unknown>): string {
  if (a.verdict === null) return "";
  const p = verdictProbability(a.verdict).toFixed(3);
  return (
    `decision model: ${a.verdict.verdict} (p ${p}, ${a.verdict.model})` +
    (a.lowPriority ? ", low priority" : "")
  );
}
