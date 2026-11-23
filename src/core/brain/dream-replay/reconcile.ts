/**
 * Timely evidence after a retirement (design D5a): a late application of
 * a rule that was retired as an unconfirmed trial, dated on or before the
 * trial's deadline, is recorded as a reconciliation. It revives nothing:
 * the daily passes retired the rule before the evidence arrived, and the
 * replay reproduces them.
 *
 * The deadline is not on a retired rule (the retirement drops it); it is
 * the last deadline the rule's own records carried before the retirement.
 * When none is there the application is counted as not checkable.
 */

import { PREFERENCE_SET_KIND } from "../../store/constants.ts";
import type { StoreEntities } from "../../store/read/store-entities.ts";
import { BRAIN_RETIRED_REASON } from "../types.ts";
import { effectId } from "./ledgers.ts";
import type { Reconciliation } from "./plan.ts";
import type { AdmittedTime } from "./records.ts";

/** The effect kind of a reconciliation. */
export const RECONCILIATION_EFFECT = "reconciliation";

/** The reconciliations a window's late applications give. */
export function reconcileLateEvidence(
  window: string,
  late: ReadonlyArray<AdmittedTime>,
  entities: StoreEntities | null,
): { readonly entries: Reconciliation[]; readonly notCheckable: number } {
  const byRule = new Map<string, AdmittedTime[]>();
  for (const entry of late) {
    if (entry.subject === undefined || entry.event_at === undefined) continue;
    const list = byRule.get(entry.subject) ?? [];
    list.push(entry);
    byRule.set(entry.subject, list);
  }
  const entries: Reconciliation[] = [];
  let notCheckable = 0;
  for (const [rule, applications] of [...byRule].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const preference = entities?.preferences.get(rule);
    if (preference === undefined) continue;
    const fields = preference.state.fields;
    if (fields["status"] !== "retired") continue;
    if (fields["retired_reason"] !== BRAIN_RETIRED_REASON.expiredUnconfirmed) continue;
    let deadline: string | null = null;
    for (const record of preference.state.history) {
      if (record.kind !== PREFERENCE_SET_KIND) continue;
      const set = (record.body["fields"] ?? {}) as Record<string, unknown>;
      if (set["status"] === "retired") break;
      if (typeof set["unconfirmed_until"] === "string") deadline = set["unconfirmed_until"];
    }
    if (deadline === null) {
      notCheckable += applications.length;
      continue;
    }
    const inTime = applications.filter(
      (entry) => Date.parse(entry.event_at!) <= Date.parse(deadline),
    );
    if (inTime.length === 0) continue;
    entries.push({
      rule,
      evidence: inTime.map((entry) => entry.id).toSorted(),
      evidence_at: [...new Set(inTime.map((entry) => entry.event_at!))].toSorted(),
      deadline,
      retired_at: typeof fields["retired_at"] === "string" ? fields["retired_at"] : null,
      effect: effectId(window, RECONCILIATION_EFFECT, rule),
    });
  }
  return { entries, notCheckable };
}
