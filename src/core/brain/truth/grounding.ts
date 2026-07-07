/**
 * Signed source-diversity grounding score (t_4678a91a / D1).
 *
 * A pure projection over the same `ClaimEvent`s that `computeTruthState`
 * folds. Where `conflicts.ts` marks a slot with a BINARY `contested`
 * flag, this module quantifies it: a signed score on [-1, +1] whose
 * SIGN points to the better-supported side (+ = the slot's current
 * value is confirmed, − = a contesting alternative is better supported)
 * and whose MAGNITUDE reflects both the balance of confirming vs
 * contradicting evidence AND how many INDEPENDENT sources back that
 * direction. A separate `confidence` band captures sufficiency.
 *
 * Kappa Graph's core insight (aaronsb/knowledge-graph-system): evidence
 * is weighed by SOURCE DIVERSITY, not raw mention count. N mentions in
 * one document weigh far below N mentions across N independent sources.
 * We honour that with a per-source repeat-mention ceiling: a single
 * source can never outweigh two independent ones.
 *
 * Deterministic (counting + weighting, no LLM), order-insensitive, and
 * never mutates the append-only ledger - exactly the `conflicts.ts`
 * discipline.
 */

import { CONFLICT_WINDOW_DAYS } from "./conflicts.ts";
import { normalizeClaimValue, slotKey } from "./fold.ts";
import type { ClaimEvent, ClaimSlot, TruthState } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Saturation constant for the diversity factor: `n / (n + K)`. With
 * K = 2, two independent confirming sources reach 0.5 and the factor
 * approaches 1 as sources accumulate - so uncontested agreement grows
 * with diversity but stays bounded below 1.
 */
export const SOURCE_SATURATION = 2;

/**
 * Ceiling on the bonus a single source earns by repeating itself. One
 * source asserting a value M times contributes `1 + CEILING·(1 − 1/M)`,
 * i.e. at most `1 + CEILING`. With CEILING = 0.5 a source maxes at 1.5,
 * so it can never outweigh two independent sources (weight 2) - the
 * source-diversity guarantee.
 */
export const REPEAT_MENTION_CEILING = 0.5;

/** Score >= this bands as `strongly_supported`. */
export const STRONGLY_SUPPORTED_MIN = 0.5;
/** Score in [MIXED_MIN, STRONGLY_SUPPORTED_MIN) bands as `mixed`. */
export const MIXED_MIN = 0.15;
/** Score in [CONTESTED_MIN, MIXED_MIN) bands as `contested`; below → `contradicted`. */
export const CONTESTED_MIN = -0.15;

/** Independent-source counts that earn each confidence band (sufficiency). */
export const CONFIDENCE_HIGH_MIN_SOURCES = 3;
export const CONFIDENCE_MEDIUM_MIN_SOURCES = 2;

export type GroundingBand = "strongly_supported" | "mixed" | "contested" | "contradicted";
export type GroundingConfidence = "high" | "medium" | "low";

export interface GroundingScore {
  /** Signed grounding on [-1, +1]; + confirms the current value, − contradicts it. */
  readonly score: number;
  /** Sufficiency band over the count of independent sources. */
  readonly confidence: GroundingConfidence;
  /** Kappa band derived from {@link score}. */
  readonly band: GroundingBand;
  /** Distinct (source, agent) pairs asserting the slot's current value. */
  readonly supportingSources: number;
  /** Distinct (source, agent) pairs asserting a contesting value within the window. */
  readonly contradictingSources: number;
}

export interface SlotGrounding {
  readonly entity: string;
  readonly aspect: string;
  readonly grounding: GroundingScore;
}

export interface GroundingOptions {
  /** Window (days) within which an opposing value counts as contradiction. */
  readonly windowDays?: number;
}

function withinWindow(aTs: string, bTs: string, windowDays: number): boolean {
  const delta = Math.abs(Date.parse(aTs) - Date.parse(bTs));
  return Number.isFinite(delta) && delta <= windowDays * DAY_MS;
}

/** Identity of one independent source: its provenance path plus asserting agent. */
function sourceIdentity(e: ClaimEvent): string {
  return `${e.source}\n${e.agent}`;
}

/** Diminishing per-source weight: 1 for a single mention, capped at 1 + ceiling. */
function sourceWeight(mentionCount: number): number {
  return 1 + REPEAT_MENTION_CEILING * (1 - 1 / mentionCount);
}

function bandFor(score: number): GroundingBand {
  if (score >= STRONGLY_SUPPORTED_MIN) return "strongly_supported";
  if (score >= MIXED_MIN) return "mixed";
  if (score >= CONTESTED_MIN) return "contested";
  return "contradicted";
}

function confidenceFor(independentSources: number): GroundingConfidence {
  if (independentSources >= CONFIDENCE_HIGH_MIN_SOURCES) return "high";
  if (independentSources >= CONFIDENCE_MEDIUM_MIN_SOURCES) return "medium";
  return "low";
}

/** Sum weights over sources in a stable (sorted-key) order so FP addition is order-insensitive. */
function totalWeight(mentionsBySource: Map<string, number>): number {
  let sum = 0;
  for (const key of [...mentionsBySource.keys()].toSorted()) {
    sum += sourceWeight(mentionsBySource.get(key)!);
  }
  return sum;
}

/**
 * Compute the signed source-diversity grounding score for one slot from
 * the raw claim events that feed it. Confirming events (matching the
 * slot's current value) count as support; opposing events asserted
 * within `windowDays` of the current value count as contradiction - a
 * value superseded outside the window is normal fact evolution, not a
 * contradiction (mirroring `conflicts.ts`). A source that ever asserts
 * the current value is a supporter, never a contradictor (self-
 * correction, not conflict). Pure and order-insensitive; the ledger is
 * never touched.
 */
export function computeGroundingScore(
  slot: ClaimSlot,
  events: ReadonlyArray<ClaimEvent>,
  opts: GroundingOptions = {},
): GroundingScore {
  const windowDays = opts.windowDays ?? CONFLICT_WINDOW_DAYS;
  const key = slotKey(slot.entity, slot.aspect);
  const currentNorm = normalizeClaimValue(slot.current.value);
  const currentTs = slot.current.ts;

  const supportMentions = new Map<string, number>();
  const contradictMentions = new Map<string, number>();

  for (const e of events) {
    if (slotKey(e.entity, e.aspect) !== key) continue;
    const id = sourceIdentity(e);
    if (normalizeClaimValue(e.value) === currentNorm) {
      supportMentions.set(id, (supportMentions.get(id) ?? 0) + 1);
    } else if (withinWindow(e.ts, currentTs, windowDays)) {
      contradictMentions.set(id, (contradictMentions.get(id) ?? 0) + 1);
    }
  }

  // A source that also supports the current value is self-correcting,
  // not a contradictor - drop it from the contradiction side.
  for (const id of supportMentions.keys()) contradictMentions.delete(id);

  const supportingSources = supportMentions.size;
  const contradictingSources = contradictMentions.size;
  const supportWeight = totalWeight(supportMentions);
  const contradictWeight = totalWeight(contradictMentions);
  const totalW = supportWeight + contradictWeight;

  const balance = totalW === 0 ? 0 : (supportWeight - contradictWeight) / totalW;
  const independentSources = supportingSources + contradictingSources;
  const diversityFactor = independentSources / (independentSources + SOURCE_SATURATION);
  const raw = balance * diversityFactor;
  // Round to tame FP noise so shuffled inputs compare exactly equal.
  const score = Math.round(raw * 1e6) / 1e6;

  return Object.freeze({
    score,
    confidence: confidenceFor(independentSources),
    band: bandFor(score),
    supportingSources,
    contradictingSources,
  });
}

/**
 * Surface the grounding projection alongside a folded {@link TruthState}:
 * one {@link SlotGrounding} per slot, in slot order. Additive - the fold
 * and its CONTESTED flags are unchanged; the score merely quantifies them.
 */
export function computeGroundings(
  state: TruthState,
  events: ReadonlyArray<ClaimEvent>,
  opts: GroundingOptions = {},
): ReadonlyArray<SlotGrounding> {
  return Object.freeze(
    state.slots.map((slot) =>
      Object.freeze({
        entity: slot.entity,
        aspect: slot.aspect,
        grounding: computeGroundingScore(slot, events, opts),
      }),
    ),
  );
}
