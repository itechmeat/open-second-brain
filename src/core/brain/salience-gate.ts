/**
 * Deterministic salience gate over the rollup ladder's fold set
 * (salience-lifecycle-enrichment, unit 1, t_de8a0b2d).
 *
 * ## What it governs, and what it does not
 *
 * The dream pass has no per-item model lane. Its entire model delegation
 * is the count-triggered rollup ladder (`rollup-ladder.ts`), which reads
 * one number - how many facts exist - and emits one envelope per fired
 * rung. So there is exactly one place a salience judgement can change
 * anything: WHICH facts are counted into that fold set. This module
 * decides that and nothing else. It never suppresses a preference, never
 * touches a retire, and never changes what the pass writes about a fact
 * it excluded.
 *
 * ## The formula
 *
 * Three signals already exist as pure functions elsewhere and are reused
 * verbatim - there is no second copy of their math here:
 *
 *   - `mass` — the dominant decayed outcome mass from `lessons.ts`,
 *     `max(positiveMass, negativeMass)`. Unbounded and >= 0. Contested
 *     evidence is loud, not cancelled: a fact people keep violating is
 *     as worth folding as one they keep applying.
 *   - `confidence` — the Wilson lower bound times freshness decay from
 *     `confidence.ts`, already in [0, 1].
 *   - `reuse` — the observed-reuse rate from `observed-use.ts`, already
 *     in [0, 1]: `(used - contradicted) / total`, clamped.
 *
 * `mass` is the only unbounded one, so it is mapped into [0, 1) by the
 * hyperbolic saturation `mass / (mass + HALF)`, which is monotone, zero
 * at zero, and exactly 0.5 at {@link SALIENCE_MASS_HALF_SATURATION}. The
 * combined score is then the weighted sum
 *
 *   score = W_mass * (mass / (mass + HALF))
 *         + W_confidence * confidence
 *         + W_reuse * reuse
 *
 * whose weights sum to 1, so the score is bounded to [0, 1] and each
 * weight reads directly as "how much of the score this signal can buy".
 * Mass leads because it is the only signal that grows with repeated
 * evidence; confidence is the corroboration term; reuse is the smallest
 * because it is the sparsest store in a young vault.
 *
 * No model, no cache, no prompt version. Recomputation is free, and a
 * cached verdict would be a second source of truth about a number three
 * pure functions already answer.
 *
 * ## Absent threshold is the documented default, not a fallback
 *
 * With `dream.salience_threshold` unset the gate is OPEN: nothing is
 * scored (so neither the log nor the continuity store is read), every
 * fact is admitted, and the verdict reports `threshold: null` so the
 * summary can say the gate was absent rather than omit the subject. A
 * malformed threshold is refused by name - the same doctrine
 * `dream-gates.ts` states for a malformed gate override, and for the
 * same reason: a knob that silently reverted is indistinguishable from
 * one the operator never set.
 */

import { computeConfidence } from "./confidence.ts";
import { computeLessons } from "./lessons.ts";
import { observedReuseRates } from "./observed-use.ts";
import { describe as describeValue } from "./policy/field-checks.ts";
import { vaultRelative } from "../path-safety.ts";
import type { BrainConfig, BrainPreference } from "./types.ts";

/** Share of the score the decayed outcome mass can buy. */
export const SALIENCE_MASS_WEIGHT = 0.5;
/** Share of the score the Wilson-bound confidence can buy. */
export const SALIENCE_CONFIDENCE_WEIGHT = 0.3;
/** Share of the score the observed-reuse rate can buy. */
export const SALIENCE_REUSE_WEIGHT = 0.2;
/**
 * Decayed mass that maps to exactly half the mass component's range.
 * Two full-weight outcomes is the anchor: one event is an anecdote, two
 * is the smallest pattern the corroboration tier in `lessons.ts` also
 * recognises.
 */
export const SALIENCE_MASS_HALF_SATURATION = 2;
/** Decimal places every reported salience number is rounded to. */
const SALIENCE_PRECISION = 4;
/** The configuration key this gate reads, spelled as an operator writes it. */
export const SALIENCE_THRESHOLD_FIELD = "dream.salience_threshold";

/**
 * Raised when a salience input cannot be honoured exactly as given.
 * Carries the field and the offending value so a caller reading only the
 * error knows which signal to fix.
 */
export class SalienceGateError extends Error {
  /** `mass`, `confidence`, `reuse`, or the config key. */
  readonly field: string;
  /** The value as supplied. */
  readonly value: unknown;

  constructor(field: string, value: unknown, requirement: string) {
    super(`salience gate: ${field} ${requirement}; got ${describeValue(value)}`);
    this.name = "SalienceGateError";
    this.field = field;
    this.value = value;
  }
}

/** The three raw signals for one fact, as their source modules report them. */
export interface SalienceComponents {
  /** Dominant decayed outcome mass; unbounded, >= 0. */
  readonly mass: number;
  /** Wilson lower bound x freshness, in [0, 1]. */
  readonly confidence: number;
  /** Observed-reuse rate, in [0, 1]. */
  readonly reuse: number;
}

/** One fact's components plus the derived numbers the gate compares. */
export interface SalienceScore extends SalienceComponents {
  /** `mass` mapped into [0, 1) by the hyperbolic saturation. */
  readonly mass_component: number;
  /** Weighted sum of the three components, in [0, 1]. */
  readonly score: number;
}

/** A preference offered to the gate, as `scanBrain` already holds it. */
export interface SalienceCandidate {
  /** Absolute path of the preference file. */
  readonly path: string;
  readonly pref: BrainPreference;
}

/** One scored member of the fold set. */
export interface SalienceFoldItem {
  readonly pref_id: string;
  /** Vault-relative path, so the verdict survives a synced vault. */
  readonly path: string;
  readonly score: SalienceScore;
}

/** A fact the gate kept out of the fold set, with the reason in numbers. */
export interface SalienceExclusion extends SalienceComponents {
  readonly pref_id: string;
  readonly path: string;
  readonly score: number;
}

/**
 * What the gate decided for one pass.
 *
 * `threshold: null` is the OPEN gate: nothing was scored, `admitted`
 * equals `considered`, and `excluded` is empty. The field is always
 * present - a summary that omitted it could not tell an absent gate from
 * a gate that excluded nothing.
 */
export interface SalienceGateVerdict {
  readonly threshold: number | null;
  /** Facts offered to the gate. */
  readonly considered: number;
  /** Facts the rollup ladder counts. */
  readonly admitted: number;
  /** Every excluded fact, by name. Never truncated, never summarised. */
  readonly excluded: ReadonlyArray<SalienceExclusion>;
}

export interface SalienceFoldSetInput {
  readonly vault: string;
  readonly preferences: ReadonlyArray<SalienceCandidate>;
  readonly cfg: BrainConfig;
  readonly now: Date;
}

function round(n: number): number {
  const factor = 10 ** SALIENCE_PRECISION;
  return Math.round(n * factor) / factor;
}

/** Refuse a component outside its domain rather than clamping it. */
function requireUnitComponent(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new SalienceGateError(field, value, "must be a number in [0, 1]");
  }
}

/**
 * Combine the three signals into one score. Pure, total, and monotone in
 * every component.
 */
export function scoreSalience(components: SalienceComponents): SalienceScore {
  const { mass, confidence, reuse } = components;
  if (!Number.isFinite(mass) || mass < 0) {
    throw new SalienceGateError("mass", mass, "must be a finite number >= 0");
  }
  requireUnitComponent("confidence", confidence);
  requireUnitComponent("reuse", reuse);
  const massComponent = round(mass / (mass + SALIENCE_MASS_HALF_SATURATION));
  return Object.freeze({
    mass,
    confidence,
    reuse,
    mass_component: massComponent,
    score: round(
      SALIENCE_MASS_WEIGHT * massComponent +
        SALIENCE_CONFIDENCE_WEIGHT * confidence +
        SALIENCE_REUSE_WEIGHT * reuse,
    ),
  });
}

/** Codepoint order, so the reported partition is machine-stable. */
function byPrefId(a: { pref_id: string }, b: { pref_id: string }): number {
  return a.pref_id < b.pref_id ? -1 : a.pref_id > b.pref_id ? 1 : 0;
}

/** The verdict for a vault with no configured threshold. Nothing is scored. */
export function openSalienceGate(considered: number): SalienceGateVerdict {
  return Object.freeze({
    threshold: null,
    considered,
    admitted: considered,
    excluded: Object.freeze([] as ReadonlyArray<SalienceExclusion>),
  });
}

/**
 * Partition a scored fold set at `threshold`. A fact scoring exactly the
 * threshold is admitted: the operator asked for "at least this salient".
 */
export function gateFoldSet(
  items: ReadonlyArray<SalienceFoldItem>,
  threshold: number,
): SalienceGateVerdict {
  requireUnitComponent(SALIENCE_THRESHOLD_FIELD, threshold);
  const excluded: SalienceExclusion[] = [];
  let admitted = 0;
  for (const entry of items) {
    if (entry.score.score >= threshold) {
      admitted++;
      continue;
    }
    excluded.push(
      Object.freeze({
        pref_id: entry.pref_id,
        path: entry.path,
        score: entry.score.score,
        mass: entry.score.mass,
        confidence: entry.score.confidence,
        reuse: entry.score.reuse,
      }),
    );
  }
  return Object.freeze({
    threshold,
    considered: items.length,
    admitted,
    excluded: Object.freeze(excluded.toSorted(byPrefId)),
  });
}

/**
 * Read the configured threshold, or `null` when the operator set none.
 * A present-but-malformed value is refused by name; it is never treated
 * as absent, because that would report an applied setting the pass did
 * not apply.
 */
export function resolveSalienceThreshold(cfg: BrainConfig): number | null {
  const raw: unknown = cfg.dream.salience_threshold;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new SalienceGateError(SALIENCE_THRESHOLD_FIELD, raw, "must be a number in [0, 1]");
  }
  return raw;
}

/**
 * Score every candidate against the three signal stores. Reads the log
 * (through `computeLessons`) and the continuity store (through
 * `observedReuseRates`) once for the whole set, never once per fact.
 */
export function collectSalienceFoldSet(
  input: SalienceFoldSetInput,
): ReadonlyArray<SalienceFoldItem> {
  const { vault, preferences, cfg, now } = input;
  if (preferences.length === 0) return Object.freeze([]);

  const lessons = computeLessons(
    vault,
    preferences.map((c) => c.pref),
    [],
    // The default limit is a rendering budget for `Brain/lessons.md`; a
    // gate that saw only the top twenty would score the rest as silent.
    { now, limit: preferences.length },
  );
  const massById = new Map<string, number>();
  for (const lesson of lessons) {
    massById.set(lesson.id, Math.max(lesson.positiveMass, lesson.negativeMass));
  }
  const reuseByKey = observedReuseRates(vault);

  return Object.freeze(
    preferences.map((candidate) => {
      const relative = vaultRelative(candidate.path, vault);
      // Observed use is keyed by path when the emitter knew one, else by
      // id; the id is tried first so a record carrying both resolves the
      // same way every run.
      const reuse = reuseByKey.get(candidate.pref.id) ?? reuseByKey.get(relative);
      return Object.freeze({
        pref_id: candidate.pref.id,
        path: relative,
        score: scoreSalience({
          mass: massById.get(candidate.pref.id) ?? 0,
          confidence: computeConfidence(
            candidate.pref.applied_count,
            candidate.pref.violated_count,
            candidate.pref.last_evidence_at,
            cfg,
            now,
          ).value,
          reuse: reuse?.score ?? 0,
        }),
      });
    }),
  );
}

/**
 * Resolve the threshold and partition the fold set. With no threshold
 * configured this reads nothing at all, so a vault that never opted in
 * pays no I/O and behaves exactly as it did before the gate existed.
 */
export function applySalienceGate(input: SalienceFoldSetInput): SalienceGateVerdict {
  const threshold = resolveSalienceThreshold(input.cfg);
  if (threshold === null) return openSalienceGate(input.preferences.length);
  return gateFoldSet(collectSalienceFoldSet(input), threshold);
}
