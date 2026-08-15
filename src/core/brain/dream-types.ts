/**
 * The input and output contract of one dream run.
 *
 * Separated from the orchestrator so every stage module (scan, plan,
 * apply, report, summary) can speak the same vocabulary without
 * importing `dream.ts` and closing a cycle back onto it. Pure type
 * declarations; no runtime code, no I/O.
 *
 * The plan-state shapes the stages exchange *between* themselves live in
 * `dream-plan.ts`; this module is only what a CALLER of `dream()` sees.
 */

import type { DreamPhaseSummary } from "./dream-phases.ts";
import type { DreamQuarantinedEntry } from "./dream-plan.ts";
import type { DreamOutcomeRegression } from "./dream-refresh.ts";
import type { BrainIntentReviewEntry } from "./intent-review.ts";
import type { RollupLadderEntry } from "./rollup-ladder.ts";
import type { BrainRetiredReason, DreamOpenQuestion } from "./types.ts";

/**
 * Structured non-fatal warning emitted alongside a dream summary. The
 * dream pass still completes when warnings are present; callers
 * (CLI / MCP) decide whether to surface them.
 */
export interface DreamWarning {
  readonly code: string;
  readonly message: string;
}

/**
 * Entry surfacing a step the dream pass attempted but could not
 * fully verify. Distinct from a `DreamWarning` (which flags
 * configuration smells): an `uncertain` entry means "I tried, no
 * hard error, but I cannot claim the operation completed". Consumed
 * by the trust verdict + operator summary (v0.10.16).
 */
export interface DreamUncertainEntry {
  /** Stable code identifying which sub-operation could not confirm. */
  readonly code: string;
  /** Optional topic slug or preference id this uncertainty concerns. */
  readonly topic?: string;
  /** Human-readable explanation. */
  readonly message: string;
}

/**
 * Brain Integrity Suite (v0.12.0). Entry for a retire that the dream
 * pass declined because `retire.confirmed_evidence_min_threshold` was
 * set and the source preference's accumulated evidence count fell
 * below it. The pref stays in `preferences/`; the operator can lift
 * the gate by raising the evidence count, lowering the threshold, or
 * running `o2b brain reject` explicitly.
 */
export interface DreamGatedRetireEntry {
  readonly pref_id: string;
  readonly topic: string;
  readonly applied_count: number;
  readonly violated_count: number;
  /** Configured threshold the pref's evidence count fell below. */
  readonly threshold: number;
  /** The retire reason the plan computed before the gate fired. */
  readonly attempted_reason: BrainRetiredReason;
}

export interface DreamRunSummary {
  /** `dream-YYYY-MM-DD-HHMMSS`. */
  readonly run_id: string;
  /** False on a true no-op run (no signals, no transitions, no retires). */
  readonly changed: boolean;
  /** Preference ids newly created in `unconfirmed` state. */
  readonly new_unconfirmed: ReadonlyArray<string>;
  /** Preference ids transitioning `unconfirmed → confirmed`. */
  readonly confirmed: ReadonlyArray<string>;
  /** Preferences moved to `retired/` and the reason for each. */
  readonly retired: ReadonlyArray<{ id: string; reason: BrainRetiredReason }>;
  /** Topic slugs where opposite-sign signals are accumulating but no
   *  state change happened yet (window not exceeded, or pinned). */
  readonly contradictions: ReadonlyArray<string>;
  /** Signal ids moved from inbox/ into inbox/processed/. */
  readonly moved_to_processed: ReadonlyArray<string>;
  /**
   * Signal ids dropped by §6 signal-suppression — a user-rejected
   * retired pref with the same topic blocked them from re-promotion.
   * Each entry is just the signal id (the retired wikilink + reason
   * land in the `signal-suppressed` log event).
   */
  readonly suppressed: ReadonlyArray<string>;
  /**
   * Non-fatal warnings raised during the run. Currently emitted only
   * for `non-primary-dream-run` (the runtime running dream differs
   * from `Brain/_brain.yaml.primary_agent`); the list is the
   * extension point for future advisory checks.
   */
  readonly warnings: ReadonlyArray<DreamWarning>;
  /**
   * Sub-operations the dream pass attempted but could not fully
   * verify. Empty on every clean run; populated by future
   * uncertainty-surfacing paths (v0.10.16).
   */
  readonly uncertain: ReadonlyArray<DreamUncertainEntry>;
  /**
   * Signal clusters held back from promotion by the self-approval
   * guardrail (v0.10.16). Empty when no cluster missed a threshold,
   * or when the guardrail is configured at default values that
   * match pre-v0.10.16 behaviour.
   */
  readonly quarantined: ReadonlyArray<DreamQuarantinedEntry>;
  /**
   * Deterministic pre-dream intent review over active signal clusters.
   * This is audit data for the two-stage gate: intent review explains
   * whether a cluster is ready for the existing main dream review,
   * needs more evidence, or is blocked by conflicting signals.
   */
  readonly intent_reviews: ReadonlyArray<BrainIntentReviewEntry>;
  /**
   * Brain Integrity Suite (v0.12.0). Retires the dream pass planned
   * but declined to execute because the source preference's evidence
   * count fell below `retire.confirmed_evidence_min_threshold`. Empty
   * when the config field is absent (the default).
   */
  readonly gated_retires: ReadonlyArray<DreamGatedRetireEntry>;
  /**
   * Outcome-regression findings (t_d478df53): confirmed preferences
   * whose recent applied events co-occur with failure outcomes. The
   * confidence penalty is already applied in this run's refresh; the
   * list is the explainable staging surface. Empty on outcome-free
   * vaults.
   */
  readonly outcome_regressions: ReadonlyArray<DreamOutcomeRegression>;
  /**
   * Multi-phase dream pipeline (Brain lifecycle suite, Feature 2).
   * Ordered per-phase summaries (close, reconcile, synthesize, heal,
   * log) for a changed run; empty on a no-op run. Additive: existing
   * fields are unchanged.
   */
  readonly phases: ReadonlyArray<DreamPhaseSummary>;
  /**
   * Count-triggered fact rollup ladder (knowledge-intake-and-
   * consolidation, S3). Fired rungs this run, each carrying its counter
   * reset and one needs-llm-step rollup envelope. Empty when no rung
   * crossed its threshold, keeping a below-threshold run byte-identical.
   */
  readonly rollups: ReadonlyArray<RollupLadderEntry>;
  /**
   * Reconcile-phase domain classification (Brain lifecycle suite,
   * Feature 3). Contradictions that stayed unresolved, each tagged with
   * a domain. Source-freshness contradictions that auto-resolved are
   * NOT listed here (they are recorded as `reconcile` log events on a
   * changed run). The legacy `contradictions` field remains a derived
   * topic-only view for back-compat.
   */
  readonly open_questions: ReadonlyArray<DreamOpenQuestion>;
  /** Snapshot file (absent on a no-op run). */
  readonly snapshot_path?: string;
  /** Log file the run summary landed in (absent on a no-op run). */
  readonly log_path?: string;
  /** True iff the run was a dry-run (no on-disk mutations performed). */
  readonly dry_run?: boolean;
}

/**
 * Per-run overrides for the dream gates that otherwise live in
 * `Brain/_brain.yaml` (no-dead-ends, Unit E). An override applies to the
 * one run it is passed to and is NEVER written back, so a targeted pass
 * needs no config edit and no remembering to revert: the stored
 * configuration is byte-identical after a run that overrode it.
 *
 * Deliberately a named field per gate rather than a general config
 * overlay. An audit of the `dream:` and `retire:` blocks found exactly one
 * boolean gate an operator flips to steer a pass
 * (`dream.heal_enrich_enabled`); `retire.confirmed_evidence_min_threshold`
 * is a numeric evidence floor, not a phase switch, and is deliberately
 * absent. A general overlay would let any resolved key be replaced for one
 * run - far more surface than the one switch that motivated this - and the
 * design doc records the narrow form as the default choice.
 */
export interface DreamGateOverrides {
  /**
   * Overrides `dream.heal_enrich_enabled` for this run only. `true` runs
   * the opt-in heal enrichment on a vault whose config leaves it off;
   * `false` skips it on a vault whose config turns it on. Omitted: the
   * configured value decides, exactly as before.
   */
  readonly heal_enrich?: boolean;
}

export interface DreamOptions {
  /** Wall clock for the run. Defaults to `new Date()`. */
  readonly now?: Date;
  /** When true, compute the plan but make no writes. */
  readonly dryRun?: boolean;
  /**
   * Identity of the agent invoking dream. Compared against
   * `Brain/_brain.yaml.primary_agent`; mismatch emits a
   * `non-primary-dream-run` warning and tags the dream summary log
   * event with `non_primary_agent: <name>`. When unset, the warning
   * never fires (back-compat with callers that have not been
   * threaded yet); the CLI always provides the value.
   */
  readonly agentName?: string;
  /**
   * Cooperative deadline (t_06784b8d). Checkpointed at exactly five
   * points, in order: entry, before the pre-run snapshot, before the
   * first mutation, after the mutation writes, and immediately before
   * the workrun is finalised. The last one (no-dead-ends, Unit E) covers
   * the tail that used to run unguarded - the log events, the rollup
   * ledger write, snapshot pruning and the active/lessons regeneration.
   * A tripped guard on the mutation path leaves the durable workrun
   * dangling, which is exactly the integrity contract - the next
   * pass spots and reports it.
   */
  readonly safeguard?: import("./safeguard.ts").Safeguard;
  /**
   * Live progress observer (nothing-runs-unwatched, U1). Optional, and
   * its absence means nobody asked - the pass behaves exactly as before.
   * Emitted at the same boundaries `safeguard` is checked at, because a
   * run worth guarding with a deadline is a run worth reporting on.
   */
  readonly onProgress?: import("./progress.ts").ProgressSink;
  /**
   * Per-run gate overrides (no-dead-ends, Unit E). Additive: omitted, the
   * run reads every gate from `Brain/_brain.yaml` exactly as before.
   */
  readonly gates?: DreamGateOverrides;
}
