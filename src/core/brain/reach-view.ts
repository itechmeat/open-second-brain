/**
 * What a caller at one transport reach may see, over the REFERENCES a
 * report row carries.
 *
 * The visibility half of the pair `./owner-scope-view.ts` opens. Both
 * bind one per-path rule to `./artifact-ref-view.ts`'s reference grammar;
 * the rules themselves are independent and neither is folded into the
 * other. A row survives a surface only if BOTH views keep it, and the
 * order they are asked in is not observable, because a hidden row is
 * dropped rather than reported by either.
 *
 * Unlike the owner view, this one is NOT gated on operator configuration.
 * `gatedOwnerScopeView` is inert unless `integrity.owner_scope_delivery`
 * is `fail`; a boundary an operator must switch on is the defect this
 * wave exists to remove, so the reach view is always live and its
 * escape hatch is the transport the caller arrived on.
 */

import { TRANSPORT_REACH, type TransportReach } from "../graph/transport-reach.ts";
import { isPathReadableAtReach } from "../search/result-filters.ts";
import {
  UNFILTERED_ARTIFACT_REFS,
  artifactRefView,
  type ArtifactRefView,
} from "./artifact-ref-view.ts";

/** The reserved-token decision, bound to one vault and one reach. */
export interface ReachView extends ArtifactRefView {
  /** The reach this view answers for. */
  readonly reach: TransportReach;
}

/**
 * Bind the reserved-token rule to one vault and one reach.
 *
 * {@link TRANSPORT_REACH.local} returns the shared no-op view, so the
 * transports that establish local access pay one comparison per call and
 * read nothing - the same shape `ownerScopeView` uses for an unset scope.
 */
export function reachView(vault: string, reach: TransportReach): ReachView {
  if (reach === TRANSPORT_REACH.local) {
    return Object.freeze({ reach, ...UNFILTERED_ARTIFACT_REFS });
  }
  return Object.freeze({
    reach,
    ...artifactRefView(vault, (rel, cache) => isPathReadableAtReach(vault, rel, reach, cache)),
  });
}
