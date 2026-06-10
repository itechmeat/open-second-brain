/**
 * Conflicts detector (continuity-hygiene-freshness suite; kanban
 * t_db375a60, detection side).
 *
 * Deterministic wrapper over the truth layer's temporal-structural
 * conflict rule (`computeTruthStateWithConflicts`): two independent
 * values for one `entity#aspect` slot inside the conflict window are
 * CONTESTED. Detection here is always deterministic; resolution
 * (supersede / merge / flag) happens later through the external
 * resolver bridge or stays `review` for the operator.
 */

import { computeTruthStateWithConflicts } from "../../truth/conflicts.ts";
import { readClaimEvents } from "../../truth/store.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneFinding } from "../types.ts";

export function detectConflicts(vault: string): ReadonlyArray<HygieneFinding> {
  const events = readClaimEvents(vault).events;
  if (events.length === 0) return Object.freeze([]);
  const state = computeTruthStateWithConflicts(events);
  return Object.freeze(
    state.conflicts.map((conflict) => {
      const slot = `${conflict.entity}#${conflict.aspect}`;
      return Object.freeze({
        id: hygieneFindingId("conflicts", [slot]),
        detector: "conflicts" as const,
        severity: "warning" as const,
        title: `Contested values for ${slot} (${conflict.values.length} contenders)`,
        targets: Object.freeze([slot]),
        proposed_action: "review" as const,
        evidence: Object.freeze({
          kind: conflict.kind,
          priority: conflict.priority,
          detected_at: conflict.detectedAt,
          values: conflict.values.map((value) => ({
            value: value.value,
            ts: value.ts,
            agent: value.agent,
            source: value.source,
            assert_count: value.assertCount,
          })),
        }),
      });
    }),
  );
}
