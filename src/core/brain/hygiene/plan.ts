/**
 * Hygiene apply plan - explicit selection of scan findings
 * (continuity-hygiene-freshness suite; kanban t_698db8f7).
 *
 * `apply` never acts on a raw scan: the operator (or a surface acting
 * for them) selects finding ids out of a scan report, and findings whose
 * proposed action the applier capability table refuses are structurally
 * excluded - they have no automated remediation by definition.
 *
 * Which actions those are is not decided here (no-dead-ends, task 8): the
 * table is the one published statement of what each applier can repair,
 * and an action it does not classify raises rather than being routed to a
 * default.
 */

import { REPAIR_VERDICT, requireRepairCapability } from "../applier-capability.ts";
import type { HygieneFinding, HygieneProposedAction, HygieneScanReport } from "./types.ts";

export interface HygienePlan {
  /** Findings selected for execution (never `review`). */
  readonly selected: ReadonlyArray<HygieneFinding>;
  /** Selected ids that pointed at review-only findings. */
  readonly excluded_review: ReadonlyArray<string>;
  /** Selected ids that matched nothing in the report. */
  readonly unknown_ids: ReadonlyArray<string>;
}

export interface BuildHygienePlanOptions {
  /** Finding ids to execute; omitted selects every actionable finding. */
  readonly ids?: ReadonlyArray<string>;
}

/**
 * Actions the unattended default selection never takes. A finding whose
 * action sits here is mechanically repairable - the capability table
 * says so - but the repair is destructive enough that it runs only when
 * a caller names its finding id, so nothing an uninvited sweep selects
 * can ever delete or drop a record. `retire` removes pages and drops
 * source records: it joins this set, and the applier-capability census
 * holds both halves of that claim (excluded unattended, selected
 * attended).
 */
export const UNATTENDED_EXCLUDED_ACTIONS: ReadonlySet<HygieneProposedAction> = new Set(["retire"]);

export function buildHygienePlan(
  report: HygieneScanReport,
  opts: BuildHygienePlanOptions = {},
): HygienePlan {
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
  const requested = opts.ids ?? report.findings.map((finding) => finding.id);
  // Explicit ids are the attended path: the caller read a scan and named
  // what should run. The omitted-ids default is unattended and holds the
  // destructive-class actions back even though they are mechanical.
  const attended = opts.ids !== undefined;

  const selected: HygieneFinding[] = [];
  const excludedReview: string[] = [];
  const unknown: string[] = [];
  for (const id of requested) {
    const finding = byId.get(id);
    if (finding === undefined) {
      unknown.push(id);
      continue;
    }
    if (requireRepairCapability(finding.proposed_action).verdict === REPAIR_VERDICT.refused) {
      excludedReview.push(id);
      continue;
    }
    if (!attended && UNATTENDED_EXCLUDED_ACTIONS.has(finding.proposed_action)) {
      excludedReview.push(id);
      continue;
    }
    selected.push(finding);
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    excluded_review: Object.freeze(excludedReview),
    unknown_ids: Object.freeze(unknown),
  });
}
