/**
 * Single-step dream requests (no-dead-ends, Unit E).
 *
 * An operator sometimes wants one piece of the dream pass rather than the
 * whole thing. Most of the pass cannot serve that request, and the honest
 * answer is a named refusal rather than a partial run:
 *
 *   - The five `DREAM_PHASE` labels are a REPORTING layer. Their metrics
 *     are assembled after all work completes, from counters produced by
 *     different functions; there is no function named `close`,
 *     `reconcile`, `synthesize`, `heal` or `log` to call.
 *   - `planRefresh` and `planAutoRetires` are two-way mutably coupled:
 *     `planRefresh` pushes into `plan.retires`, and `planAutoRetires`
 *     deletes those slugs out of `refresh.updated`, precisely so that a
 *     preference is never both refreshed and retired in one pass. Running
 *     either alone with writes enabled is a data-correctness bug, not a
 *     missing feature.
 *
 * Exactly two units of work are provably independent, and this module
 * offers those two and refuses everything else by name:
 *
 *   - `scan` - {@link scanBrain}, a pure read of the `Brain/` tree. It
 *     opens no writer, takes no clock and mutates nothing.
 *   - `heal-enrich` - {@link runHealEnrichment}, the opt-in deterministic
 *     vault enrichment. It reads and rewrites user pages outside the Brain
 *     root and shares no accumulator with the planning steps. Asking for
 *     it IS the opt-in, so it runs regardless of
 *     `dream.heal_enrich_enabled`; that config key gates the automatic
 *     pass, and `DreamOptions.gates` overrides it for one full run.
 *
 * ## What a partial run returns
 *
 * NOT a `DreamRunSummary`. Almost every field of that record is
 * produced by steps a single-step request does not run, so returning one
 * would assert `retired: []` and `changed: false` about work that never
 * happened - a misleading fallback of exactly the kind this release
 * removes. Each step returns its own shape instead, discriminated by
 * `step` and marked `partial: true`, carrying only what that step actually
 * observed or did.
 */

import { scanBrain } from "./dream.ts";
import { DREAM_PHASE, type DreamPhase } from "./dream-phases.ts";
import { runHealEnrichment } from "./heal-run.ts";
import { vaultRelative } from "./paths.ts";
import type { ProgressSink } from "./progress.ts";
import type { Safeguard } from "./safeguard.ts";

/** The units of dream work that are provably runnable on their own. */
export const DREAM_STEP = Object.freeze({
  scan: "scan",
  healEnrich: "heal-enrich",
} as const);

export type DreamStep = (typeof DREAM_STEP)[keyof typeof DREAM_STEP];

/** Canonical order the refusal message lists the runnable steps in. */
export const DREAM_STEP_RUNNABLE: ReadonlyArray<DreamStep> = Object.freeze([
  DREAM_STEP.scan,
  DREAM_STEP.healEnrich,
]);

/**
 * Why each reporting label cannot be honoured on its own. One entry per
 * `DREAM_PHASE` member: a caller asking for a phase gets the reason for
 * THAT phase, never a generic "unsupported" line.
 */
const PHASE_REFUSAL: Readonly<Record<DreamPhase, string>> = Object.freeze({
  [DREAM_PHASE.close]:
    `it labels both the read scan and the pre-run snapshot that the mutating pass rolls back to, ` +
    `and a snapshot outside a run has nothing to protect; its read half is the '${DREAM_STEP.scan}' step`,
  [DREAM_PHASE.reconcile]:
    `it classifies contradictions over the plan that planTopics builds in the same pass, and records ` +
    `the outcome as run-log events; it owns no state of its own to run against`,
  [DREAM_PHASE.synthesize]:
    `planRefresh and planAutoRetires mutate each other's accumulators - planRefresh pushes into ` +
    `plan.retires and planAutoRetires deletes those slugs out of refresh.updated - so that a ` +
    `preference is never both refreshed and retired; running the refresh half alone with writes ` +
    `enabled would write a preference that the same pass had decided to retire`,
  [DREAM_PHASE.heal]:
    `its retire half is the other side of the planRefresh/planAutoRetires accumulator coupling ` +
    `(planAutoRetires deletes from refresh.updated the slugs planRefresh queued into plan.retires), ` +
    `so retiring alone would drop a refresh the same pass computed; its enrichment half is ` +
    `available on its own as the '${DREAM_STEP.healEnrich}' step`,
  [DREAM_PHASE.log]:
    `it writes the run summary and audit events describing work that a single-step request did not ` +
    `perform, so running it alone would record a pass that never happened`,
});

/** Reason given for a token that is not even a reporting label. */
const UNKNOWN_STEP_REFUSAL =
  "it is neither a runnable dream step nor one of the dream reporting phases";

/**
 * Raised when a caller asks for a step the dream pass cannot perform in
 * isolation. Carries the requested token, the steps that ARE runnable, and
 * the specific reason - so an agent reading only the error knows both why
 * it was refused and what it may ask for instead.
 */
export class DreamStepNotRunnableError extends Error {
  /** The token the caller asked for, verbatim. */
  readonly requested: string;
  /** The steps {@link runDreamStep} does honour. */
  readonly runnable: ReadonlyArray<DreamStep>;
  /** Why {@link requested} specifically cannot be run alone. */
  readonly reason: string;

  constructor(requested: string, reason: string) {
    super(
      `dream step '${requested}' is not independently runnable: ${reason}. ` +
        `Independently runnable steps: ${DREAM_STEP_RUNNABLE.join(", ")}. ` +
        `Everything else runs only as part of a full dream() pass.`,
    );
    this.name = "DreamStepNotRunnableError";
    this.requested = requested;
    this.runnable = DREAM_STEP_RUNNABLE;
    this.reason = reason;
  }
}

/** Result of the `scan` step: what the read saw, and nothing more. */
export interface DreamScanStepResult {
  readonly step: typeof DREAM_STEP.scan;
  /** Always true: this is one step of the pass, not a run summary. */
  readonly partial: true;
  /** Signals still in `inbox/`. */
  readonly active_signals: number;
  /** Signals already in `inbox/processed/`. */
  readonly processed_signals: number;
  readonly preferences: number;
  readonly retired: number;
  /** Vault-relative paths whose frontmatter would not parse. */
  readonly corrupted: ReadonlyArray<string>;
}

/** Result of the `heal-enrich` step: what the enrichment rewrote. */
export interface DreamHealEnrichStepResult {
  readonly step: typeof DREAM_STEP.healEnrich;
  /** Always true: this is one step of the pass, not a run summary. */
  readonly partial: true;
  /** User pages considered (the Brain root is never touched). */
  readonly scanned: number;
  readonly enriched: number;
  /** Paths actually rewritten, sorted. */
  readonly pages: ReadonlyArray<string>;
}

export type DreamStepResult = DreamScanStepResult | DreamHealEnrichStepResult;

/**
 * What a caller may hand a single-step request.
 *
 * A step is a whole call, not a phase of one: nothing above it holds a
 * deadline or a stream, so both belong here and both are forwarded
 * unchanged to whichever step runs. This is a DISPATCHER over two units
 * of work and owns no counter of its own - each step opens exactly one
 * stream, named for the stage it is - which is the same shape the
 * maintenance lane takes over its four tasks, and for the same reason: a
 * second counter here would put two terminators on one run.
 *
 * Until this existed the MCP `step` branch passed neither, so a step over
 * a large tree held the server's event loop with no upper bound and said
 * nothing while it did.
 */
export interface DreamStepOptions {
  /** Cooperative deadline, honoured at the step's own iteration boundary. */
  readonly safeguard?: Safeguard;
  /** Where the step reports; absence means nobody asked. */
  readonly onProgress?: ProgressSink;
}

/**
 * Run exactly one dream step, or refuse by name.
 *
 * Never runs more than was asked and never runs less: a request this
 * function cannot honour in full throws {@link DreamStepNotRunnableError}
 * and writes nothing.
 */
export function runDreamStep(
  vault: string,
  step: string,
  opts: DreamStepOptions = {},
): DreamStepResult {
  switch (step) {
    case DREAM_STEP.scan: {
      const scan = scanBrain(vault, opts);
      return Object.freeze({
        step: DREAM_STEP.scan,
        partial: true,
        active_signals: scan.signals.filter((s) => s.active).length,
        processed_signals: scan.signals.filter((s) => !s.active).length,
        preferences: scan.preferences.length,
        retired: scan.retired.length,
        corrupted: Object.freeze(scan.corrupted.map((c) => vaultRelative(c.path, vault))),
      } satisfies DreamScanStepResult);
    }
    case DREAM_STEP.healEnrich: {
      const result = runHealEnrichment(vault, opts);
      return Object.freeze({
        step: DREAM_STEP.healEnrich,
        partial: true,
        scanned: result.scanned,
        enriched: result.enriched,
        pages: Object.freeze([...result.pages]),
      } satisfies DreamHealEnrichStepResult);
    }
    default:
      throw new DreamStepNotRunnableError(step, refusalReason(step));
  }
}

/** The specific reason for a refused token. */
function refusalReason(step: string): string {
  return Object.hasOwn(PHASE_REFUSAL, step)
    ? PHASE_REFUSAL[step as DreamPhase]
    : UNKNOWN_STEP_REFUSAL;
}
