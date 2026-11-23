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
import type { SalienceGateVerdict } from "./salience-gate.ts";

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
  /** The gate's verdict over the fold set the ladder would have counted. */
  readonly salienceGate: SalienceGateVerdict;
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
    salience_gate: input.salienceGate,
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
  /** The gate's verdict over the fold set `rollupPlan` counted. */
  readonly salienceGate: SalienceGateVerdict;
  readonly intentReviews: ReadonlyArray<BrainIntentReviewEntry>;
  readonly warnings: ReadonlyArray<DreamWarning>;
  readonly gatedRetires: ReadonlyArray<DreamGatedRetireEntry>;
  /** Slugs the evidence gate held back; excluded from `retired`. */
  readonly gatedSlugs: ReadonlySet<string>;
  readonly moved: ReadonlyArray<string>;
  /** Signal ids archived (or, on a dry run, that would be). */
  readonly archived: ReadonlyArray<string>;
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
    salience_gate: input.salienceGate,
    open_questions: Object.freeze([...reconcile.openQuestions]),
    new_unconfirmed: plan.newUnconfirmed.map((p) => `pref-${p.slug}`),
    confirmed: Array.from(refresh.confirmed.values()).map((s) => `pref-${s}`),
    retired: plan.retires
      .filter((r) => !gatedSlugs.has(r.slug))
      .map((r) => ({ id: `ret-${r.slug}`, reason: r.reason })),
    contradictions: Array.from(plan.contradictionTopics),
    moved_to_processed: input.moved,
    // Absent rather than empty, so a run that archived nothing keeps the
    // summary shape it has always had.
    ...(input.archived.length > 0 ? { archived_signals: input.archived } : {}),
    // Cross-topic rule promotions (t_642bc2b8). Absent rather than
    // empty for the same reason: a pass that promoted nothing - every
    // un-opted-in pass among them - keeps the summary bytes it always
    // had.
    ...(plan.crossTopicRules.length > 0
      ? { cross_topic_rules: plan.crossTopicRules.map((r) => `pref-${r.slug}`) }
      : {}),
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
      cross_topic_rules: plan.crossTopicRules.length,
    }),
    phaseSummary(DREAM_PHASE.heal, {
      retired: plan.retires.filter((r) => !gatedSlugs.has(r.slug)).length,
      enriched: input.healEnriched,
    }),
    phaseSummary(DREAM_PHASE.log, {
      moved: input.moved.length,
      suppressed: plan.signalsSuppressed.length,
      archived: input.archived.length,
    }),
  ]);
}

/** Build one phase summary (module-scoped: captures nothing). */
function phaseSummary(phase: DreamPhase, metrics: Record<string, number>): DreamPhaseSummary {
  return { phase, metrics };
}

/**
 * The summary of a pass that evaluated several windows (change
 * `dream-replay`): what each window did, in window order. Lists are
 * joined, the pass changed something when any window did, the phase
 * counts add up, and every value that describes one moment (the salience
 * verdict, the run id, the log path) is the last window's.
 */
export function mergeWindowSummaries(summaries: ReadonlyArray<DreamRunSummary>): DreamRunSummary {
  if (summaries.length === 1) return summaries[0]!;
  const last = summaries.at(-1)!;
  const all = <T>(pick: (s: DreamRunSummary) => ReadonlyArray<T> | undefined): T[] =>
    summaries.flatMap((s) => [...(pick(s) ?? [])]);
  const phases = new Map<
    string,
    { phase: DreamPhaseSummary["phase"]; metrics: Record<string, number> }
  >();
  for (const summary of summaries) {
    for (const entry of summary.phases) {
      const into = phases.get(entry.phase) ?? { phase: entry.phase, metrics: {} };
      for (const [name, value] of Object.entries(entry.metrics)) {
        into.metrics[name] = (into.metrics[name] ?? 0) + value;
      }
      phases.set(entry.phase, into);
    }
  }
  const archived = all((s) => s.archived_signals);
  const crossTopic = all((s) => s.cross_topic_rules);
  const snapshot = summaries.find((s) => s.snapshot_path !== undefined)?.snapshot_path;
  return Object.freeze({
    ...last,
    changed: summaries.some((s) => s.changed),
    new_unconfirmed: all((s) => s.new_unconfirmed),
    confirmed: all((s) => s.confirmed),
    retired: all((s) => s.retired),
    contradictions: [...new Set(all((s) => s.contradictions))],
    moved_to_processed: all((s) => s.moved_to_processed),
    ...(archived.length > 0 ? { archived_signals: archived } : {}),
    ...(crossTopic.length > 0 ? { cross_topic_rules: crossTopic } : {}),
    suppressed: all((s) => s.suppressed),
    warnings: all((s) => s.warnings),
    uncertain: all((s) => s.uncertain),
    quarantined: last.quarantined,
    intent_reviews: last.intent_reviews,
    // A declined retire is declined again by every later window: once each.
    gated_retires: [
      ...new Map(all((s) => s.gated_retires).map((g) => [g.pref_id, g] as const)).values(),
    ],
    outcome_regressions: last.outcome_regressions,
    phases: last.phases.length === 0 && phases.size === 0 ? last.phases : [...phases.values()],
    rollups: all((s) => s.rollups),
    open_questions: last.open_questions,
    ...(snapshot !== undefined ? { snapshot_path: snapshot } : {}),
  } satisfies DreamRunSummary);
}
