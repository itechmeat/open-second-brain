/**
 * Conflict detection (t_e9692750): a policy layer over the base truth
 * fold. The rule is purely temporal-structural - two distinct values
 * for one slot whose assertions land within the conflict window and
 * come from independent sources are CONTESTED (typed conflict,
 * `resolution: ask_user`, never auto-resolved); a later value outside
 * the window supersedes silently because that is normal fact
 * evolution, not contradiction.
 */

import { computeTruthState } from "./fold.ts";
import type { ClaimEvent, ClaimSlot, ClaimVersion, TruthConflict, TruthState } from "./types.ts";

/** Two values asserted within this many days of each other contest. */
export const CONFLICT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConflictOptions {
  /** Override the conflict window, in days. */
  readonly windowDays?: number;
}

function withinWindow(aTs: string, bTs: string, windowDays: number): boolean {
  const delta = Math.abs(Date.parse(aTs) - Date.parse(bTs));
  return Number.isFinite(delta) && delta <= windowDays * DAY_MS;
}

/**
 * Contesting versions for one slot: every history value whose latest
 * assertion is within the window of the current value AND whose source
 * differs (same source changing its value is self-correction). Returns
 * chronological order ending with the current value, or null when
 * nothing contests.
 */
function contestingValues(slot: ClaimSlot, windowDays: number): ClaimVersion[] | null {
  const contesting = slot.history
    .filter(
      (v) => withinWindow(v.ts, slot.current.ts, windowDays) && v.source !== slot.current.source,
    )
    .toReversed(); // history is newest-first; conflicts read chronologically
  if (contesting.length === 0) return null;
  return [...contesting, slot.current];
}

/**
 * The full fold with conflicts materialized and `contested` flags set.
 * With no conflicting events the output is deeply equal to
 * {@link computeTruthState} - the neutral default stays bit-identical.
 */
export function computeTruthStateWithConflicts(
  events: ReadonlyArray<ClaimEvent>,
  opts: ConflictOptions = {},
): TruthState {
  const windowDays = opts.windowDays ?? CONFLICT_WINDOW_DAYS;
  const base = computeTruthState(events);

  const conflicts: TruthConflict[] = [];
  const slots: ClaimSlot[] = [];
  let changed = false;

  for (const slot of base.slots) {
    const values = contestingValues(slot, windowDays);
    if (values === null) {
      slots.push(slot);
      continue;
    }
    changed = true;
    conflicts.push(
      Object.freeze({
        entity: slot.entity,
        aspect: slot.aspect,
        kind: "value_conflict" as const,
        values: Object.freeze(values),
        priority: values.length,
        resolution: "ask_user" as const,
        detectedAt: slot.current.ts,
      }),
    );
    slots.push(Object.freeze({ ...slot, contested: true }));
  }

  if (!changed) return base;
  // Slots are already sorted by (entity, aspect) in the base fold, so
  // conflicts built in slot order inherit the same deterministic sort.
  return Object.freeze({
    ...base,
    slots: Object.freeze(slots),
    conflicts: Object.freeze(conflicts),
  });
}
