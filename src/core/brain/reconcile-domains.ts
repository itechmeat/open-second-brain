/**
 * Reconcile-phase domain classification (Brain lifecycle suite,
 * Feature 3).
 *
 * Replaces the dream pass's flat "contradiction topic" list with a
 * deterministic, STRUCTURAL classifier. A contradiction (positive vs
 * negative signals on one topic) is bucketed into one of four domains
 * from signal shape only - never from language. The resolver then
 * auto-resolves ONLY the `source-freshness` domain, and only when one
 * side is materially fresher than the other (beyond a margin); every
 * judgement domain - claims, entity, decisions - and an ambiguous
 * freshness case become operator-facing open questions rather than a
 * forced merge.
 *
 * This is the deterministic subset of the "parallel-agent truth
 * reconciliation" idea: no LLM fan-out, no network, injectable clock.
 */

import {
  RECONCILE_DOMAIN,
  type DreamOpenQuestion,
  type ReconcileDomain,
} from "./types.ts";

// Re-export so callers can reach the domain enum + type from the
// reconciler module without also importing types.ts.
export { RECONCILE_DOMAIN, type ReconcileDomain } from "./types.ts";

/** Minimal signal view the reconciler needs. Decoupled from BrainSignal. */
export interface ReconcileSignal {
  /** ISO-8601 transaction/creation time. */
  readonly created_at: string;
  /** Optional bi-temporal record time; preferred over created_at when set. */
  readonly recorded_at?: string;
  /** Optional context wikilinks; a non-empty list marks an entity contradiction. */
  readonly source?: ReadonlyArray<string>;
}

export interface ContradictionInput {
  readonly topic: string;
  readonly scope?: string;
  readonly positives: ReadonlyArray<ReconcileSignal>;
  readonly negatives: ReadonlyArray<ReconcileSignal>;
}

export type ReconcileOutcome =
  | {
      readonly kind: "auto-resolved";
      readonly domain: typeof RECONCILE_DOMAIN.sourceFreshness;
      /** Sign of the side that wins (the materially fresher one). */
      readonly winner_sign: "positive" | "negative";
      readonly margin_days: number;
    }
  | {
      readonly kind: "open-question";
      readonly question: DreamOpenQuestion;
    };

/** Conventional scope value marking a judgement/decision contradiction. */
const DECISIONS_SCOPE = "decisions";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Effective recency anchor for a signal: recorded_at if present, else created_at. */
function signalTimeMs(s: ReconcileSignal): number {
  const raw = s.recorded_at ?? s.created_at;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Newest effective time across a set of signals, or -Infinity if empty. */
function newestMs(signals: ReadonlyArray<ReconcileSignal>): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const s of signals) {
    const t = signalTimeMs(s);
    if (t > max) max = t;
  }
  return max;
}

function hasEntityReference(signals: ReadonlyArray<ReconcileSignal>): boolean {
  return signals.some((s) => (s.source?.length ?? 0) > 0);
}

/**
 * Classify a contradiction into a domain from structural signal shape.
 * Priority: decisions (scope marker) > entity (wikilink sources) >
 * source-freshness (a recency separation) > claims (default).
 */
export function classifyContradiction(input: ContradictionInput): ReconcileDomain {
  if (input.scope === DECISIONS_SCOPE) return RECONCILE_DOMAIN.decisions;
  if (
    hasEntityReference(input.positives) ||
    hasEntityReference(input.negatives)
  ) {
    return RECONCILE_DOMAIN.entity;
  }
  const posNewest = newestMs(input.positives);
  const negNewest = newestMs(input.negatives);
  if (
    Number.isFinite(posNewest) &&
    Number.isFinite(negNewest) &&
    posNewest !== negNewest
  ) {
    return RECONCILE_DOMAIN.sourceFreshness;
  }
  return RECONCILE_DOMAIN.claims;
}

/**
 * Resolve a contradiction. Auto-resolves only the source-freshness
 * domain when the fresher side leads by at least `freshnessMarginDays`;
 * otherwise returns an open question carrying the classified domain.
 */
export function resolveContradiction(
  input: ContradictionInput,
  opts: { now: Date; freshnessMarginDays: number },
): ReconcileOutcome {
  const domain = classifyContradiction(input);

  if (domain === RECONCILE_DOMAIN.sourceFreshness) {
    const posNewest = newestMs(input.positives);
    const negNewest = newestMs(input.negatives);
    const gapDays = Math.abs(posNewest - negNewest) / MS_PER_DAY;
    if (gapDays >= opts.freshnessMarginDays) {
      return {
        kind: "auto-resolved",
        domain: RECONCILE_DOMAIN.sourceFreshness,
        winner_sign: negNewest > posNewest ? "negative" : "positive",
        margin_days: Math.floor(gapDays),
      };
    }
    return openQuestion(input, domain, "freshness-gap-below-margin");
  }

  return openQuestion(input, domain, `${domain}-needs-operator`);
}

function openQuestion(
  input: ContradictionInput,
  domain: ReconcileDomain,
  reason: string,
): ReconcileOutcome {
  return {
    kind: "open-question",
    question: {
      topic: input.topic,
      ...(input.scope ? { scope: input.scope } : {}),
      domain,
      positive_count: input.positives.length,
      negative_count: input.negatives.length,
      reason,
    },
  };
}
