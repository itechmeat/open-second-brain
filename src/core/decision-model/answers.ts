/**
 * Per-item validation of a decision-model reply.
 *
 * A reply is validated item by item: an item that fails is marked
 * `valid: false` and every use treats it as absent, while the rest of the
 * batch stands. Nothing here throws on a bad item; only a reply whose
 * overall shape is unusable is rejected by the adapter.
 *
 * Shared by every adapter that returns the `systemone` answer shape, so
 * the rules cannot drift between routes.
 */

import type { DecisionAnswer, DecisionQuestion } from "./contract.ts";

/** How far a probability distribution may sum from 1 and still count. */
export const PROBABILITY_SUM_TOLERANCE = 0.02;

/** Client-side limits the wire format declares. */
export const CHOICE_MIN_OPTIONS = 1;
export const CHOICE_MAX_OPTIONS = 255;
export const SCORE_MIN_LEVELS = 2;
export const SCORE_MAX_LEVELS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function invalid(type: DecisionQuestion["type"]): DecisionAnswer {
  return Object.freeze({ type, value: Number.NaN, valid: false });
}

/**
 * Confidence from a distribution over `n` outcomes when the provider did
 * not report one: `(n * p_max - 1) / (n - 1)`, 0 for a uniform
 * distribution and 1 for a certain one. Confidences from different
 * providers are not comparable, so this is only a stand-in.
 */
export function recomputeConfidence(probabilities: ReadonlyArray<number>, n: number): number {
  if (n < 2) return 1;
  const pMax = Math.max(...probabilities, 0);
  const c = (n * pMax - 1) / (n - 1);
  return Math.min(1, Math.max(0, c));
}

/**
 * Read a probability map whose keys must all be in `allowed`. Returns null
 * when any key is unknown, any value is not a probability, or the sum is
 * off by more than {@link PROBABILITY_SUM_TOLERANCE}. Missing keys count
 * as 0.
 */
function readDistribution(
  raw: unknown,
  allowed: ReadonlyArray<string>,
): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const allowedSet = new Set(allowed);
  const out: Record<string, number> = {};
  for (const key of allowed) out[key] = 0;
  let sum = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedSet.has(key) || !isProbability(value)) return null;
    out[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return null;
  return out;
}

function readConfidence(raw: unknown, fallback: number): number {
  return isProbability(raw) ? raw : fallback;
}

/** Validate one reply item against the question it answers. */
export function validateAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isRecord(raw)) return invalid(question.type);
  if (raw["type"] !== undefined && raw["type"] !== question.type) return invalid(question.type);

  if (question.type === "noul") {
    const p = raw["noul"];
    if (!isProbability(p)) return invalid("noul");
    return Object.freeze({ type: "noul", value: p, valid: true });
  }

  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const choice = raw["choice"];
    if (typeof choice !== "string" || !options.includes(choice)) return invalid("choice");
    const probabilities = readDistribution(raw["probabilities"], options);
    if (probabilities === null) return invalid("choice");
    const pMax = Math.max(...Object.values(probabilities));
    // The reported choice must be the argmax (ties allowed): a reply
    // whose label and distribution disagree says nothing reliable.
    if (probabilities[choice]! + 1e-9 < pMax) return invalid("choice");
    const confidence = readConfidence(
      raw["confidence"],
      recomputeConfidence(Object.values(probabilities), options.length),
    );
    return Object.freeze({
      type: "choice",
      value: choice,
      probabilities: Object.freeze(probabilities),
      confidence,
      valid: true,
    });
  }

  const levels = question.criteria.length;
  const keys = Array.from({ length: levels }, (_, i) => String(i));
  const probabilities = readDistribution(raw["probabilities"], keys);
  if (probabilities === null) return invalid("score");
  const expected = keys.reduce((acc, key, i) => acc + i * probabilities[key]!, 0);
  const reported = raw["score"];
  const value =
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported >= 0 &&
    reported <= levels - 1
      ? reported
      : expected;
  const confidence = readConfidence(
    raw["confidence"],
    recomputeConfidence(Object.values(probabilities), levels),
  );
  return Object.freeze({
    type: "score",
    value,
    probabilities: Object.freeze(probabilities),
    confidence,
    valid: true,
  });
}

/**
 * Client-side limits, checked before anything is sent. Returns the first
 * violation as a sentence, or null when every question is within limits.
 * `maxChoiceOptions` is the route's own limit (52 for OpenJev, for
 * example), never above the wire maximum.
 */
export function questionLimitViolation(
  questions: Readonly<Record<string, DecisionQuestion>>,
  maxChoiceOptions: number = CHOICE_MAX_OPTIONS,
): string | null {
  const maxOptions = Math.min(CHOICE_MAX_OPTIONS, Math.max(CHOICE_MIN_OPTIONS, maxChoiceOptions));
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const n = Object.keys(q.criteria).length;
      if (n < CHOICE_MIN_OPTIONS || n > maxOptions) {
        return `question '${id}': a choice needs ${CHOICE_MIN_OPTIONS}-${maxOptions} options on this route, got ${n}`;
      }
    } else if (q.type === "score") {
      const n = q.criteria.length;
      if (n < SCORE_MIN_LEVELS || n > SCORE_MAX_LEVELS) {
        return `question '${id}': a score needs ${SCORE_MIN_LEVELS}-${SCORE_MAX_LEVELS} levels, got ${n}`;
      }
    }
  }
  return null;
}
