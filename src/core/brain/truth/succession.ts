/**
 * Succession classification (truth-correctable-time-aware, contract
 * item 1): the policy-layer sibling of `conflicts.ts`. A same-slot
 * claim pair is succession if and only if BOTH claims carry present
 * validity windows and the windows do not intersect; every other pair
 * keeps the assertion-time contest rule verbatim, and an expired
 * window never suppresses contestation on its own.
 *
 * Succession stays outside the conflict vocabulary on purpose: it is a
 * separate, presence-gated channel on {@link TruthState}, never a
 * `TruthConflictKind`, so `ask_user` semantics, hygiene findings and
 * conflict priority are structurally unreachable from here. Pure
 * functions; no I/O, no clock.
 */

import { normalizeClaimValue, slotKey } from "./fold.ts";
import type { ClaimEvent, ClaimSuccession } from "./types.ts";
import { claimWindow, windowsIntersect } from "./validity.ts";

/**
 * Whether one same-slot claim pair classifies as succession: distinct
 * values, both claims carrying present windows, windows
 * non-intersecting. Re-assertions of one value are never succession -
 * they are the same fact restated, and they can never contest either.
 */
export function isSuccessionPair(a: ClaimEvent, b: ClaimEvent): boolean {
  if (normalizeClaimValue(a.value) === normalizeClaimValue(b.value)) return false;
  const wa = claimWindow(a);
  const wb = claimWindow(b);
  if (wa === null || wb === null) return false;
  return !windowsIntersect(wa, wb);
}

/**
 * Whether two values inside one slot are fully separated by the
 * succession rule: every cross-pair of their claims satisfies
 * {@link isSuccessionPair}. Any windowless or intersecting cross-pair
 * keeps today's contest behavior verbatim, so the conflict policy may
 * exclude a version pair from contestation only under this predicate.
 * Value comparison uses the fold's normalized identity.
 */
export function valuesSuccessionSeparated(
  slotEvents: ReadonlyArray<ClaimEvent>,
  valueA: string,
  valueB: string,
): boolean {
  const normA = normalizeClaimValue(valueA);
  const normB = normalizeClaimValue(valueB);
  if (normA === normB) return false;
  const groupA = slotEvents.filter((e) => normalizeClaimValue(e.value) === normA);
  const groupB = slotEvents.filter((e) => normalizeClaimValue(e.value) === normB);
  if (groupA.length === 0 || groupB.length === 0) return false;
  return groupA.every((a) => groupB.every((b) => isSuccessionPair(a, b)));
}

/** Stable total order over events: (ts, agent, source, value) - the fold's order. */
function compareEvents(a: ClaimEvent, b: ClaimEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.agent !== b.agent) return a.agent < b.agent ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.value !== b.value) return a.value < b.value ? -1 : 1;
  return 0;
}

/** The latest-asserted claim of one normalized value inside a slot. */
function latestClaimForValue(slotEvents: ReadonlyArray<ClaimEvent>, normValue: string): ClaimEvent {
  const group = slotEvents.filter((e) => normalizeClaimValue(e.value) === normValue);
  return group.reduce((latest, e) => (compareEvents(e, latest) > 0 ? e : latest));
}

/**
 * Classify successions over all claim events, one {@link ClaimSuccession}
 * per slot value-pair that is fully succession-separated. The
 * predecessor is the representative claim (latest assertion) whose
 * window closes first - non-intersection guarantees a finite earlier
 * end, so the ordering is total. Output sorts by slot key for
 * determinism; the result is independent of input order.
 */
export function classifyClaimSuccessions(
  events: ReadonlyArray<ClaimEvent>,
): ReadonlyArray<ClaimSuccession> {
  const bySlot = new Map<string, ClaimEvent[]>();
  for (const e of events) {
    const key = slotKey(e.entity, e.aspect);
    const list = bySlot.get(key);
    if (list === undefined) bySlot.set(key, [e]);
    else list.push(e);
  }

  const out: ClaimSuccession[] = [];
  for (const key of [...bySlot.keys()].toSorted()) {
    const slotEvents = bySlot.get(key)!;
    const [entity, aspect] = key.split("\n") as [string, string];
    const values = [...new Set(slotEvents.map((e) => normalizeClaimValue(e.value)))].toSorted();
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        if (!valuesSuccessionSeparated(slotEvents, values[i]!, values[j]!)) continue;
        const first = latestClaimForValue(slotEvents, values[i]!);
        const second = latestClaimForValue(slotEvents, values[j]!);
        const firstUntil = claimWindow(first)!.untilMs ?? Number.POSITIVE_INFINITY;
        const secondUntil = claimWindow(second)!.untilMs ?? Number.POSITIVE_INFINITY;
        const [predecessor, successor] =
          firstUntil <= secondUntil ? [first, second] : [second, first];
        out.push(
          Object.freeze({
            entity,
            aspect,
            predecessor: Object.freeze(predecessor),
            successor: Object.freeze(successor),
            detectedAt: successor.ts,
          }),
        );
      }
    }
  }
  return Object.freeze(out);
}
