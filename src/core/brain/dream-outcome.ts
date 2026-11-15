/**
 * The decisions a dream pass takes about its own outcome once the plan is
 * known: whether anything changes at all (the `changed` gate), the
 * non-fatal warnings it reports, and the retire-sibling projection a
 * changed run's summary carries. Pure over the plan; split from
 * `dream.ts`, which sequences them.
 */

import { resolveNearDuplicateRetireSiblingsEnabled } from "../config.ts";
import { shouldGateRetireFromConfirmed } from "./dream-apply.ts";
import type { PlanState, ScanResult } from "./dream-plan.ts";
import type { RefreshResult } from "./dream-refresh.ts";
import type { DreamGatedRetireEntry, DreamRunSummary, DreamWarning } from "./dream-types.ts";
import { READ_ALL_REFS } from "./near-duplicate.ts";
import { planRetireSiblings, retireSiblingPool } from "./retire-siblings.ts";
import type { RollupLadderPlan } from "./rollup-ladder.ts";

/**
 * Attach the retire-sibling projection (near-duplicate defense) to a
 * changed run's summary. Computed from the completed retire plan, then
 * reconciled against the retires the confirmed-evidence gate holds back:
 * the ones the apply step gated, or on a dry run the ones it would gate,
 * so the dry run and the real run agree. A retiring preference is never
 * refreshed first, so its scanned frontmatter is what the apply step
 * reads. The scan is the pass's own reach (a preview scan is already
 * admitted), hence {@link READ_ALL_REFS}. Off (`enabled`, else the
 * default config's key), or with nothing to report, the summary is
 * returned untouched.
 */
export function withRetireSiblings(
  summary: DreamRunSummary,
  scan: ScanResult,
  plan: PlanState,
  opts: {
    readonly enabled: boolean | undefined;
    readonly gatedRetires: ReadonlyArray<DreamGatedRetireEntry>;
    readonly previewGateThreshold: number | undefined;
  },
): DreamRunSummary {
  if (plan.retires.length === 0 || !(opts.enabled ?? resolveNearDuplicateRetireSiblingsEnabled())) {
    return summary;
  }
  const gated = new Set(opts.gatedRetires.map((g) => g.pref_id));
  if (opts.previewGateThreshold !== undefined) {
    const byId = new Map(scan.preferences.map((p) => [p.pref.id, p.pref] as const));
    for (const r of plan.retires) {
      const existing = byId.get(`pref-${r.slug}`);
      if (
        existing !== undefined &&
        shouldGateRetireFromConfirmed(existing, r.reason, opts.previewGateThreshold)
      ) {
        gated.add(existing.id);
      }
    }
  }
  const siblings = planRetireSiblings(
    retireSiblingPool(scan.preferences.map((p) => p.pref)),
    plan.retires.map((r) => ({ id: `pref-${r.slug}`, principle: r.principle, reason: r.reason })),
    { readable: READ_ALL_REFS, gated },
  );
  if (siblings.length === 0) return summary;
  return Object.freeze({ ...summary, retire_siblings: Object.freeze([...siblings]) });
}

/**
 * Non-fatal warnings raised during the run. The non-primary-dream-run
 * check is the first one: when the caller declares an agent name and it
 * differs from the vault's declared primary, surface a structured
 * warning. We do NOT abort — the declaration is observability, not
 * access control.
 */
export function collectWarnings(
  isNonPrimary: boolean,
  callerAgent: string,
  primaryAgent: string | null,
): DreamWarning[] {
  if (!isNonPrimary) return [];
  return [
    {
      code: "non-primary-dream-run",
      message:
        `dream run from agent '${callerAgent}', but primary is ` +
        `'${primaryAgent}'. Convention violation, run proceeds.`,
    },
  ];
}

/**
 * Decide if anything is going to change. We treat any of the following
 * as a state change:
 *   - a new unconfirmed pref
 *   - a refreshed pref (counters/confidence/status changed)
 *   - a retire
 *   - a same-sign signal noted on an active pref (move + log)
 *   - an inbox signal archived because it left the contradiction window
 *   - a corrupted frontmatter (we want the skip event recorded)
 *   - any pinned-rebut-attempt warning
 *   - a fired rollup-ladder rung (S3)
 *   - a cross-topic rule promotion (t_642bc2b8)
 */
export function hasStateChange(
  plan: PlanState,
  refresh: RefreshResult,
  corruptedCount: number,
  rollupPlan: RollupLadderPlan,
): boolean {
  return (
    plan.newUnconfirmed.length > 0 ||
    refresh.confirmed.size > 0 ||
    refresh.updated.size > 0 ||
    plan.retires.length > 0 ||
    plan.notedRedundant.length > 0 ||
    plan.signalsToMove.size > 0 ||
    plan.signalsToArchive.size > 0 ||
    plan.retainPinned.length > 0 ||
    plan.signalsSuppressed.length > 0 ||
    // v0.10.16: quarantine is a recorded decision (deferred-but-noted),
    // so a run that produces only quarantine entries is still a
    // meaningful run from the operator's perspective.
    plan.quarantined.length > 0 ||
    plan.crossTopicRules.length > 0 ||
    rollupPlan.fired ||
    corruptedCount > 0
  );
}
