/**
 * Selectable recall profiles (Recall & Working-Memory Quality Suite,
 * t_98c39dd6 profile-half).
 *
 * A profile is a NAMED point in the same bounded parameter space the
 * self-tuning grid (`tuning.ts`) already ranges over - candidate-pool
 * multiplier, traversal depth, learned weights, query expansion. It is
 * applied through the SAME `applyTunedParameters` machinery, so an
 * operator-chosen profile and a learned grid point stay coherent and
 * cannot diverge into a parallel knob set.
 *
 * Philosophy mirrors `tuning.ts`: the values live in ONE frozen table,
 * nothing outside the enumerated names can be resolved, and an unknown
 * name fails loud (a typed `SearchError`) rather than degrading to a
 * silent default. No profile selected at all leaves `search()` on its
 * existing config path, byte-for-byte.
 */

import type { TunedParameters } from "./tuning.ts";
import { SearchError } from "./types.ts";

/** The selectable profile names, narrowest-to-widest. */
export const RECALL_PROFILE_NAMES = Object.freeze(["fast", "balanced", "thorough"] as const);

export type RecallProfileName = (typeof RECALL_PROFILE_NAMES)[number];

/**
 * The fixed profile table. Every tuple stays within the self-tuning
 * grid bounds (pool ∈ {3,4,5}, depth ∈ {1,2}) so profiles never reach a
 * parameter the tuner could not also choose. `fast` is the narrowest
 * point (smallest pool, single hop, no learned weights, no expansion);
 * `thorough` is the widest; `balanced` sits between.
 */
const PROFILE_TABLE: Readonly<Record<RecallProfileName, TunedParameters>> = Object.freeze({
  fast: Object.freeze({
    poolMultiplier: 3,
    traversalDepth: 1,
    learnedWeights: false,
    expansion: false,
  }),
  balanced: Object.freeze({
    poolMultiplier: 4,
    traversalDepth: 1,
    learnedWeights: true,
    expansion: false,
  }),
  thorough: Object.freeze({
    poolMultiplier: 5,
    traversalDepth: 2,
    learnedWeights: true,
    expansion: true,
  }),
});

/** True only for the enumerated profile names. */
export function isRecallProfileName(value: unknown): value is RecallProfileName {
  return (
    typeof value === "string" && (RECALL_PROFILE_NAMES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Resolve a profile name to its frozen knob tuple. Unknown name throws a
 * typed `SearchError("INVALID_INPUT")` whose message lists the valid
 * names - never a silent fallback to a default profile.
 */
export function resolveRecallProfile(name: string): TunedParameters {
  if (!isRecallProfileName(name)) {
    throw new SearchError(
      "INVALID_INPUT",
      `unknown recall profile: ${name} (expected one of ${RECALL_PROFILE_NAMES.join(", ")})`,
    );
  }
  return PROFILE_TABLE[name];
}
