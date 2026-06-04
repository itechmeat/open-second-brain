/**
 * Exact-match quantity aggregation (t_220c313e): "how much did I
 * spend" answers combine ONLY values whose (entity, action, unit)
 * tuple matches the query exactly after canonical normalization. A
 * number that is merely nearby - a different unit, a different
 * measured action, a text-kind slot - never pollutes a total. That
 * structural exactness is the whole feature.
 */

import { normalizeEntityName } from "../entities/canonical.ts";
import type { ClaimSlot } from "./types.ts";

export interface AggregateQuery {
  /** Optional entity filter; omitted means every entity combines. */
  readonly entity?: string;
  /** Measured action, exact match after normalization. */
  readonly action: string;
  /** Unit token; null matches only unitless quantities. */
  readonly unit: string | null;
}

export interface AggregateContribution {
  readonly entity: string;
  readonly aspect: string;
  readonly value: number;
  readonly source: string;
  readonly ts: string;
}

export interface AggregateResult {
  readonly action: string;
  readonly unit: string | null;
  readonly total: number;
  readonly count: number;
  readonly contributions: ReadonlyArray<AggregateContribution>;
}

function normalizeUnit(raw: string | null): string | null {
  if (raw === null) return null;
  const unit = normalizeEntityName(raw);
  return unit === "" ? null : unit;
}

/**
 * Sum the CURRENT value of every slot whose quantity matches the
 * query tuple exactly. Superseded history never aggregates - the
 * ledger's current-truth surface is what totals are about.
 */
export function aggregateQuantities(
  slots: ReadonlyArray<ClaimSlot>,
  query: AggregateQuery,
): AggregateResult {
  const wantEntity = query.entity !== undefined ? normalizeEntityName(query.entity) : null;
  const wantAction = normalizeEntityName(query.action);
  const wantUnit = normalizeUnit(query.unit);

  const contributions: AggregateContribution[] = [];
  for (const slot of slots) {
    if (wantEntity !== null && slot.entity !== wantEntity) continue;
    const current = slot.current;
    if (current.valueKind !== "quantity" || current.quantity === undefined) continue;
    const q = current.quantity;
    if (q.action === null || normalizeEntityName(q.action) !== wantAction) continue;
    if (normalizeUnit(q.unit) !== wantUnit) continue;
    contributions.push(
      Object.freeze({
        entity: slot.entity,
        aspect: slot.aspect,
        value: q.value,
        source: current.source,
        ts: current.ts,
      }),
    );
  }

  contributions.sort((a, b) => {
    if (a.entity !== b.entity) return a.entity < b.entity ? -1 : 1;
    return a.aspect < b.aspect ? -1 : a.aspect > b.aspect ? 1 : 0;
  });

  return Object.freeze({
    action: wantAction,
    unit: wantUnit,
    total: contributions.reduce((sum, c) => sum + c.value, 0),
    count: contributions.length,
    contributions: Object.freeze(contributions),
  });
}
