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
import type { HygieneFinding, HygieneScanReport } from "./types.ts";

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

export function buildHygienePlan(
  report: HygieneScanReport,
  opts: BuildHygienePlanOptions = {},
): HygienePlan {
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
  const requested = opts.ids ?? report.findings.map((finding) => finding.id);

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
    selected.push(finding);
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    excluded_review: Object.freeze(excludedReview),
    unknown_ids: Object.freeze(unknown),
  });
}
