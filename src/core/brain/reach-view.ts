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

import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../graph/transport-reach.ts";
import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import { pathIsInside, posixRel } from "../path-safety.ts";
import { type FrontmatterCache, isPathReadableAtReach } from "../search/result-filters.ts";
import { parseFrontmatterWithNotices } from "../vault.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";
import {
  isStoreRecordReadableAtReach,
  storeRecordLookup,
  storeRecordRefView,
} from "./store-record-visibility.ts";
import {
  UNFILTERED_ARTIFACT_REFS,
  artifactRefView,
  type ArtifactRefView,
} from "./artifact-ref-view.ts";

/**
 * The page rule below local reach while the question whether the machine
 * reads its records from the store fails (change `lane-reach-residuals`,
 * design R3): a `Brain/` page may be a record of the `private` partition
 * and is withheld (fail closed); a page outside `Brain/` is no store
 * record, so its own file answers, as on a machine whose pages are files.
 * `isPathReadableAtReach` asks that question for every path, so the
 * file's entry goes into the per-response cache first and the rule itself
 * is unchanged.
 */
function pageVisibleWhileStoreUnknown(
  vault: string,
  rel: string,
  reach: TransportReach,
  cache: FrontmatterCache,
): boolean {
  const spelled = posixRel(rel);
  if (spelled === BRAIN_ROOT_REL || spelled.startsWith(`${BRAIN_ROOT_REL}/`)) return false;
  const path = join(vault, spelled);
  if (!pathIsInside(path, vault)) return false;
  if (!cache.has(spelled)) {
    const [meta, , notices] = parseFrontmatterWithNotices(path, { site: "brain.reach-view" });
    cache.set(
      spelled,
      Object.freeze({
        meta,
        unreadable: notices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable),
      }),
    );
  }
  return isPathReadableAtReach(vault, spelled, reach, cache);
}

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
export function reachView(vault: string | null, reach: TransportReach): ReachView {
  if (reach === TRANSPORT_REACH.local) {
    return Object.freeze({ reach, ...UNFILTERED_ARTIFACT_REFS });
  }
  // No vault (design D14): every page a reference can name is a record.
  if (vault === null) {
    return Object.freeze({
      reach,
      ...storeRecordRefView((page) => isStoreRecordReadableAtReach(page, reach), true),
      withholdsPrivate: true,
    });
  }
  // Store-only (task 2.10): a preference or signal is judged by its record.
  // A failed store-mode question still builds the view: the lane verdict
  // withholds every lane-shaped reference (`unknown`), and the page rule
  // withholds every `Brain/` page, so only the rows that name one are
  // withheld (change `lane-reach-residuals`, design R3).
  let record: ReturnType<typeof storeRecordLookup>;
  let storeUnknown = false;
  try {
    record = storeRecordLookup(vault);
  } catch {
    record = null;
    storeUnknown = true;
  }
  return Object.freeze({
    reach,
    ...artifactRefView(
      vault,
      (rel, cache) => {
        if (storeUnknown) return pageVisibleWhileStoreUnknown(vault, rel, reach, cache);
        const page = record?.(rel);
        if (page !== undefined) return isStoreRecordReadableAtReach(page, reach);
        return isPathReadableAtReach(vault, rel, reach, cache);
      },
      // Below local reach a reference the store cannot place may name a
      // `private` entry: hidden (fail closed), and the lane verdict comes
      // before any disk match.
      () => false,
      true,
    ),
    withholdsPrivate: true,
  });
}
