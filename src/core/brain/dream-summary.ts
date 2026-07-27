/**
 * The dream pass's return value: what a caller (CLI, MCP, trust verdict)
 * sees after a run.
 *
 * One reason to change: the public {@link DreamRunSummary} contract.
 * Two constructors, because a run ends in exactly one of two shapes and
 * they carry different guarantees:
 *
 *   - {@link buildNoOpSummary} — nothing changed. No snapshot, no log
 *     path, no phases, no rollups; the fields that only a mutation can
 *     populate are frozen empty rather than omitted, so consumers never
 *     branch on presence.
 *   - {@link buildChangedSummary} — the run mutated the vault, so the
 *     snapshot and log paths are real and the per-phase counters exist.
 *
 * Pure: no I/O, no clock. Every value is derived from state the earlier
 * stages already produced.
 */

import { DREAM_PHASE, type DreamPhase, type DreamPhaseSummary } from "./dream-phases.ts";
import type { PlanState, ScanResult } from "./dream-plan.ts";
import type { RefreshResult } from "./dream-refresh.ts";
import type {
  DreamGatedRetireEntry,
  DreamRunSummary,
  DreamUncertainEntry,
  DreamWarning,
} from "./dream-types.ts";
import type { BrainIntentReviewEntry } from "./intent-review.ts";
import type { ReconcileOutcomes } from "./reconcile-outcomes.ts";
import type { RollupLadderEntry, RollupLadderPlan } from "./rollup-ladder.ts";

/** Empty, frozen views for the fields a no-op run cannot populate. */
const NO_UNCERTAIN = Object.freeze([] as ReadonlyArray<DreamUncertainEntry>);
const NO_GATED_RETIRES = Object.freeze([] as ReadonlyArray<DreamGatedRetireEntry>);
const NO_PHASES = Object.freeze([] as ReadonlyArray<DreamPhaseSummary>);
const NO_ROLLUPS = Object.freeze([] as ReadonlyArray<RollupLadderEntry>);

export interface DreamNoOpSummaryInput {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly plan: PlanState;
  readonly refresh: RefreshResult;
  readonly reconcile: ReconcileOutcomes;
  readonly intentReviews: ReadonlyArray<BrainIntentReviewEntry>;
  readonly warnings: ReadonlyArray<DreamWarning>;
}

export function buildNoOpSummary(input: DreamNoOpSummaryInput): DreamRunSummary {
  const { plan, refresh, reconcile } = input;
  return Object.freeze({
    run_id: input.runId,
    changed: false,
    new_unconfirmed: [],
    confirmed: [],
    retired: [],
    contradictions: [...plan.contradictionTopics],
    moved_to_processed: [],
    suppressed: [],
    warnings: Object.freeze([...input.warnings]),
    uncertain: NO_UNCERTAIN,
    quarantined: Object.freeze([...plan.quarantined]),
    intent_reviews: Object.freeze([...input.intentReviews]),
    gated_retires: NO_GATED_RETIRES,
    outcome_regressions: Object.freeze([...refresh.outcomeRegressions]),
    phases: NO_PHASES,
    rollups: NO_ROLLUPS,
    open_questions: Object.freeze([...reconcile.openQuestions]),
    ...(input.dryRun ? { dry_run: true } : {}),
  } satisfies DreamRunSummary);
}

export interface DreamChangedSummaryInput {
  readonly runId: string;
  /**
   * The mutually-exclusive tail of the summary: a dry run reports
   * `dry_run: true` and wrote nothing, a real run reports the day file
   * its summary event landed in. The caller builds it so the write-path
   * vault-identity assertion behind that path is never reached on a dry
   * run.
   */
  readonly runTail: { readonly dry_run: true } | { readonly log_path: string };
  readonly scan: ScanResult;
  readonly plan: PlanState;
  readonly refresh: RefreshResult;
  readonly reconcile: ReconcileOutcomes;
  readonly rollupPlan: RollupLadderPlan;
  readonly intentReviews: ReadonlyArray<BrainIntentReviewEntry>;
  readonly warnings: ReadonlyArray<DreamWarning>;
  readonly gatedRetires: ReadonlyArray<DreamGatedRetireEntry>;
  /** Slugs the evidence gate held back; excluded from `retired`. */
  readonly gatedSlugs: ReadonlySet<string>;
  readonly moved: ReadonlyArray<string>;
  readonly healEnriched: number;
  /** Absent on a dry run, which writes no snapshot. */
  readonly snapshotPath: string | undefined;
}

export function buildChangedSummary(input: DreamChangedSummaryInput): DreamRunSummary {
  const { plan, refresh, reconcile, gatedSlugs } = input;
  return Object.freeze({
    run_id: input.runId,
    changed: true,
    phases: buildPhaseSummaries(input),
    rollups: Object.freeze([...input.rollupPlan.entries]),
    open_questions: Object.freeze([...reconcile.openQuestions]),
    new_unconfirmed: plan.newUnconfirmed.map((p) => `pref-${p.slug}`),
    confirmed: Array.from(refresh.confirmed.values()).map((s) => `pref-${s}`),
    retired: plan.retires
      .filter((r) => !gatedSlugs.has(r.slug))
      .map((r) => ({ id: `ret-${r.slug}`, reason: r.reason })),
    contradictions: Array.from(plan.contradictionTopics),
    moved_to_processed: input.moved,
    suppressed: plan.signalsSuppressed.map((s) =>
      s.signal.replace(/^\[\[/, "").replace(/\]\]$/, ""),
    ),
    warnings: Object.freeze([...input.warnings]),
    uncertain: NO_UNCERTAIN,
    quarantined: Object.freeze([...plan.quarantined]),
    intent_reviews: Object.freeze([...input.intentReviews]),
    gated_retires: Object.freeze([...input.gatedRetires]),
    outcome_regressions: Object.freeze([...refresh.outcomeRegressions]),
    ...(input.snapshotPath ? { snapshot_path: input.snapshotPath } : {}),
    ...input.runTail,
  } satisfies DreamRunSummary);
}

/**
 * Multi-phase dream (F2): structured per-phase summaries for a changed
 * run. Metrics are integer counters derived from the plan/refresh that
 * already ran; additive keys may appear in later versions.
 */
function buildPhaseSummaries(input: DreamChangedSummaryInput): ReadonlyArray<DreamPhaseSummary> {
  const { scan, plan, refresh, reconcile, gatedSlugs } = input;
  return Object.freeze([
    phaseSummary(DREAM_PHASE.close, {
      active_signals: scan.signals.filter((s) => s.active).length,
      preferences: scan.preferences.length,
      retired_files: scan.retired.length,
    }),
    phaseSummary(DREAM_PHASE.reconcile, {
      contradictions: plan.contradictionTopics.size,
      open_questions: reconcile.openQuestions.length,
      auto_resolved: reconcile.autoResolved.length,
    }),
    phaseSummary(DREAM_PHASE.synthesize, {
      new_unconfirmed: plan.newUnconfirmed.length,
      confirmed: refresh.confirmed.size,
    }),
    phaseSummary(DREAM_PHASE.heal, {
      retired: plan.retires.filter((r) => !gatedSlugs.has(r.slug)).length,
      enriched: input.healEnriched,
    }),
    phaseSummary(DREAM_PHASE.log, {
      moved: input.moved.length,
      suppressed: plan.signalsSuppressed.length,
    }),
  ]);
}

/** Build one phase summary (module-scoped: captures nothing). */
function phaseSummary(phase: DreamPhase, metrics: Record<string, number>): DreamPhaseSummary {
  return { phase, metrics };
}
