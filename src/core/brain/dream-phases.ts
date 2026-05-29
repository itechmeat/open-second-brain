/**
 * Multi-phase dream pipeline labels (Brain lifecycle suite, Feature 2).
 *
 * The proven `dream()` internals are NOT rewritten. This module only
 * names the existing seams as explicit ordered phases so the pass emits
 * one workrun checkpoint and one structured summary per phase:
 *
 *   close      - scan the tree, snapshot the starting counts
 *   reconcile  - contradiction handling + domain classification (F3)
 *   synthesize - promote / confirm / refresh preferences
 *   heal       - auto-retire stale, optional vault enrichment (F6)
 *   log        - emit events + audit, finalise
 *
 * Ordering guarantees reconcile-before-synthesize and heal-after the
 * mutating writes. The phase list is the contract; `DreamPhaseSummary`
 * carries integer metrics so a run is auditable without re-deriving.
 */

export const DREAM_PHASE = {
  close: "close",
  reconcile: "reconcile",
  synthesize: "synthesize",
  heal: "heal",
  log: "log",
} as const;
export type DreamPhase = (typeof DREAM_PHASE)[keyof typeof DREAM_PHASE];

/** Canonical phase order. Readers MUST tolerate unknown future phases. */
export const DREAM_PHASE_ORDER: ReadonlyArray<DreamPhase> = Object.freeze([
  DREAM_PHASE.close,
  DREAM_PHASE.reconcile,
  DREAM_PHASE.synthesize,
  DREAM_PHASE.heal,
  DREAM_PHASE.log,
]);

/**
 * One phase's structured summary. `metrics` holds integer counters
 * describing what the phase observed or did; the keys are phase-specific
 * and additive (new keys may appear in future versions).
 */
export interface DreamPhaseSummary {
  readonly phase: DreamPhase;
  readonly metrics: Readonly<Record<string, number>>;
}
