/**
 * The shared graded surfacing key (t_107a3249, lane C).
 *
 * ONE pure calculator computes recall admission for every channel from a
 * retrieval result plus a transport, so the hook's `decideRecallInject`
 * and the `brain_recall_gate` diagnostics grade identically instead of
 * drifting into two competing signals.
 *
 * The KEY is absolute match quality - the share of the prompt's IDF mass
 * the retrieved material actually covers (`SearchOutcome.idfWeightedCoverage`).
 * It is the only quantity here with a threshold contract, and the same
 * quantity `recall-adequacy.ts` grades. A result score can NOT take this
 * role: the keyword lane min-max normalizes within the candidate set, so
 * whenever that lane is non-empty the top row sits at or above the
 * configured keyword weight no matter how well it matched - the defect
 * documented in `recall-adequacy.ts` and in the floor's docblock in
 * `recall-inject.ts`. The fused composite stays an ORDERING signal in
 * `rankResults`; it is never read here.
 *
 * The CHANNEL is the transport (`RECALL_CHANNEL`: mcp, cli, hook),
 * because every telemetry record already carries it and the replay bench
 * can therefore reproduce it; anything finer belongs in metadata. The
 * per-channel admission floors are exported module constants, not config
 * knobs, this wave. All three sit at `RECALL_INJECT_CONFIDENCE_FLOOR`
 * (0.35) - the one bound with shipped measured behaviour - and the replay
 * suite (`src/core/bench/replay.ts`) is the instrument that re-measures
 * them: if a measured calibration disagrees with 0.35 before release,
 * the measurement wins and this docblock records it.
 *
 * Structural truths (empty prompt, verbatim repeat, slash command, shell
 * command) are channel-INDEPENDENT and never enter this calculator; they
 * stay named short-circuits in `evaluateSurfacingGate`, which projects
 * this key's `{ key, tier, admit, reason }` shape alongside its own
 * binary decision.
 */

import type { RecallChannel } from "../brain/recall-telemetry.ts";

/**
 * The graded tier vocabulary, weakest to strongest admission.
 *
 * `explicit` and `suppressed` are the gate's structural outcomes (an
 * explicit recall request; a named short-circuit). `admitted`,
 * `below_floor` and `unmeasurable_quality` are this calculator's
 * measured outcomes, and the latter two are members of the decision
 * core's `RecallAbstainReason` vocabulary verbatim, so a tier boundary
 * surfaces the SAME reason on every channel.
 */
export const SURFACING_TIER = Object.freeze({
  explicit: "explicit",
  suppressed: "suppressed",
  admitted: "admitted",
  belowFloor: "below_floor",
  unmeasurable: "unmeasurable_quality",
} as const);

/** Closed union over {@link SURFACING_TIER}. */
export type SurfacingTier = (typeof SURFACING_TIER)[keyof typeof SURFACING_TIER];

/** Membership list; every surface renders its enum from this array. */
export const SURFACING_TIERS: ReadonlyArray<SurfacingTier> = Object.freeze([
  SURFACING_TIER.explicit,
  SURFACING_TIER.suppressed,
  SURFACING_TIER.admitted,
  SURFACING_TIER.belowFloor,
  SURFACING_TIER.unmeasurable,
]);

/** Narrow a value read back off disk or across a tool boundary. */
export function isSurfacingTier(value: unknown): value is SurfacingTier {
  return typeof value === "string" && (SURFACING_TIERS as ReadonlyArray<string>).includes(value);
}

/**
 * Per-channel admission floors over absolute match quality, in [0,1].
 *
 * The hook member is pinned by test to equal
 * `RECALL_INJECT_CONFIDENCE_FLOOR` - the hook's floor is DERIVED from
 * this constant (single source of truth), keeping the exported name and
 * value its callers already pin. The mcp/cli diagnostic channels default
 * to the same floor this wave; the replay suite is what re-measures that
 * default (see the module docblock).
 */
export const SURFACING_ADMISSION_FLOORS: Readonly<Record<RecallChannel, number>> = Object.freeze({
  mcp: 0.35,
  cli: 0.35,
  hook: 0.35,
});

/** Typed error for a measurable quality or floor that violates its own contract. */
export class SurfacingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfacingKeyError";
  }
}

/** Input to the shared admission calculator. */
export interface SurfacingKeyInput {
  /**
   * Absolute match quality in [0,1] - `RecallResultSet.idfWeightedCoverage`
   * or `recall_adequacy`'s `match_quality`. `null` when the retrieval had
   * no IDF mass to weigh (a word-free prompt or an empty corpus); that is
   * a REPORT, and it grades as `unmeasurable_quality`.
   */
  readonly matchQuality: number | null;
  readonly channel: RecallChannel;
  /**
   * Overrides the channel's constant. The hook's configurable
   * `confidenceFloor` rides here; absent, the channel constant applies.
   */
  readonly floor?: number;
}

/**
 * One admission verdict as the graded shape `{ key, tier, admit, reason }`.
 *
 * `key` is the measured quality (null only where nothing was measurable);
 * `tier` and `reason` carry the same closed-vocabulary member on the
 * measured outcomes, with `reason` kept as its own field so structural
 * projections can put a gate reason in the same slot; `admit` is the
 * decision itself. At-boundary quality admits: the decision core has
 * always abstained strictly below the floor, and that boundary is pinned.
 */
export type SurfacingKeyDecision =
  | {
      readonly key: number;
      readonly tier: typeof SURFACING_TIER.admitted;
      readonly admit: true;
      readonly reason: typeof SURFACING_TIER.admitted;
    }
  | {
      readonly key: number;
      readonly tier: typeof SURFACING_TIER.belowFloor;
      readonly admit: false;
      readonly reason: typeof SURFACING_TIER.belowFloor;
    }
  | {
      readonly key: null;
      readonly tier: typeof SURFACING_TIER.unmeasurable;
      readonly admit: false;
      readonly reason: typeof SURFACING_TIER.unmeasurable;
    };

/**
 * Compute the graded admission for one retrieval result on one channel.
 *
 * Throws {@link SurfacingKeyError} - by name, never a silent fallback -
 * when a reported quality or floor is not a finite number in [0,1]: a
 * retriever that reports `NaN` where the contract says `null` is broken,
 * and admitting on it is how a broken bound hides.
 */
export function computeSurfacingKey(input: SurfacingKeyInput): SurfacingKeyDecision {
  const floor = input.floor ?? SURFACING_ADMISSION_FLOORS[input.channel];
  assertUnitInterval(floor, "floor");
  if (input.matchQuality === null) {
    return Object.freeze({
      key: null,
      tier: SURFACING_TIER.unmeasurable,
      admit: false,
      reason: SURFACING_TIER.unmeasurable,
    });
  }
  assertUnitInterval(input.matchQuality, "matchQuality");
  if (input.matchQuality < floor) {
    return Object.freeze({
      key: input.matchQuality,
      tier: SURFACING_TIER.belowFloor,
      admit: false,
      reason: SURFACING_TIER.belowFloor,
    });
  }
  return Object.freeze({
    key: input.matchQuality,
    tier: SURFACING_TIER.admitted,
    admit: true,
    reason: SURFACING_TIER.admitted,
  });
}

function assertUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new SurfacingKeyError(`${name} must be a finite number in [0,1]; got ${value}`);
  }
}

/**
 * Validate one measured quality for callers that admit without grading
 * (an explicit request carries its measurement but never thresholds on
 * it). Shared so the explicit path and the calculator refuse the same
 * broken numbers with the same named error.
 */
export function assertMeasuredQuality(key: number): number {
  assertUnitInterval(key, "matchQuality");
  return key;
}
