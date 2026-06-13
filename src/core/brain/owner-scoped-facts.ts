/**
 * Owner-scoped fact visibility (Knowledge Provenance suite).
 *
 * A preference may declare an `owner:` token. When several agents write to one
 * brain, owner-scoped recall keeps each owner's facts separate while shared
 * (ownerless) facts stay visible to all. This module is the fact-layer
 * application of the v1.6 owner-visibility model - it REUSES
 * `src/core/graph/agent-scope.ts` (pageOwner / isOwnerVisible) rather than
 * reimplementing the rule, so the fact layer and the v1.6 search agent-scope
 * share one visibility definition. It is wired into `brain_query` (the
 * per-request fact-recall surface); only preferences carry an `owner`.
 *
 * The default is byte-identical: when no scope is requested (null), every fact
 * is visible exactly as today.
 */

import { isOwnerVisible, pageOwner } from "../graph/agent-scope.ts";
import type { BrainPreference } from "./types.ts";

/** The normalized owner token of a preference, or null when ownerless. */
export function preferenceOwner(pref: Pick<BrainPreference, "owner">): string | null {
  return pageOwner({ owner: pref.owner ?? "" });
}

/**
 * Whether a preference is visible under a requested owner scope. A null scope
 * (no scope requested) makes everything visible; an ownerless fact is always
 * visible; an owned fact is visible only to its own normalized scope.
 */
export function isPreferenceVisible(
  pref: Pick<BrainPreference, "owner">,
  requestedScope: string | null,
): boolean {
  return isOwnerVisible(preferenceOwner(pref), requestedScope);
}
