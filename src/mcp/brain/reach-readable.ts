/**
 * May the caller of one request read a vault page at this path?
 *
 * A tool that reads a page's bytes on the caller's behalf and answers
 * something derived from them - whether a span occurs in it, which
 * capture scope it backs - must answer at the caller's reach, or the
 * derived answer discloses what the page itself would not. This module
 * binds the two existing per-path rules to one request, and adds no rule
 * of its own:
 *
 *   - visibility: `isPathReadableAtReach` at the reach the transport
 *     minted (`contextReach`, fail closed when none was minted);
 *   - ownership: `isPathOwnerVisible` under the server-resolved identity,
 *     only when `integrity.owner_scope_delivery` is `fail` (the same gate
 *     `gatedOwnerScopeView` reads).
 *
 * The predicate is a plain vault-relative path test rather than an
 * `ArtifactRefView`, because the reference view reads a path without a
 * `.md` extension as a Brain artifact id, and a source path may name any
 * vault file.
 */

import { join, resolve } from "node:path";

import { isOwnerVisible, pageOwner } from "../../core/graph/agent-scope.ts";
import { remoteDenyVisibilityTokens } from "../../core/graph/privacy-markers.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../core/graph/transport-reach.ts";
import { isRemotelyReadable } from "../../core/graph/visibility.ts";
import {
  lanePagesInStore,
  laneVaultRoot,
  readLanePage,
  type LanePage,
} from "../../core/store/lane-pages.ts";
import { BRAIN_ROOT_REL } from "../../core/brain/path-constants.ts";
import { pathIsInside } from "../../core/path-safety.ts";
import { resolveOwnerScopeDelivery } from "../../core/brain/preferences-collect.ts";
import {
  isPathOwnerVisible,
  isPathReadableAtReach,
  type FrontmatterCache,
} from "../../core/search/result-filters.ts";
import { contextReach, type ServerContext, contextVault } from "../tool-contract.ts";

/** A vault-relative path test bound to one request's reach and owner. */
export type ReadablePredicate = (rel: string) => boolean;

/** Every path readable: the answer for a local reach with the ownership gate off. */
const READ_EVERYTHING: ReadablePredicate = () => true;

/**
 * The predicate for one request. Local reach with the ownership gate off
 * answers `true` without touching the filesystem.
 */
export function readableAtContextReach(ctx: ServerContext): ReadablePredicate {
  return readableAtContextReachOrUndefined(ctx) ?? READ_EVERYTHING;
}

/**
 * The predicate for one request, or `undefined` when it would withhold
 * nothing (local reach with the ownership gate off), so a reader that
 * skips work for an absent filter can be handed no filter at all.
 */
export function readableAtContextReachOrUndefined(
  ctx: ServerContext,
): ReadablePredicate | undefined {
  const reach = contextReach(ctx);
  const vault = contextVault(ctx);
  // A server with no vault is store-only: its record-lane pages are store
  // records, measured by the same frontmatter rules below; local reach
  // with the gate off withholds nothing.
  if (vault === null) return vaultlessReadable(ctx, reach);
  const scope = resolveOwnerScopeDelivery(vault, ctx.agentName).enforcedScope;
  if (reach === TRANSPORT_REACH.local && scope === null) return undefined;
  const root = resolve(ctx.vault);
  const cache: FrontmatterCache = new Map();
  const inVault: ReadablePredicate = (rel) =>
    // A path that leaves the vault names no page the caller could be
    // shown, and is answered before anything is read.
    pathIsInside(resolve(root, rel), root) &&
    isPathReadableAtReach(ctx.vault, rel, reach, cache) &&
    (scope === null || isPathOwnerVisible(ctx.vault, rel, scope, cache));
  if (!lanePagesInStore(vault)) return inVault;
  // A store-only machine: a record-lane page under `Brain/` is a store
  // record, measured from its fields; any other path (a memory page, a
  // vault note) is judged by the vault rules. Containment is answered
  // first, so a traversing path reads nothing.
  const lanes = storeLaneReadable(reach, scope);
  return (rel) => {
    const path = resolve(root, rel);
    if (!pathIsInside(path, root)) return false;
    const page = underBrain(root, path) ? readLanePage(vault, join(vault, rel)) : null;
    return page !== null ? lanes(page) : inVault(rel);
  };
}

/** Whether `path` (already inside `root`) is under `root`'s `Brain/` folder. */
function underBrain(root: string, path: string): boolean {
  return pathIsInside(path, join(root, BRAIN_ROOT_REL));
}

/**
 * The predicate of a server with no vault: a record-lane page is a lane
 * record (`storeLaneReadable`), a memory page (a preference or a signal)
 * is its store record, judged by `isPathReadableAtReach` and the owner
 * rule over the fields the record carries; local reach with the gate off
 * withholds nothing.
 */
function vaultlessReadable(
  ctx: ServerContext,
  reach: TransportReach,
): ReadablePredicate | undefined {
  const scope = resolveOwnerScopeDelivery(null, ctx.agentName).enforcedScope;
  if (reach === TRANSPORT_REACH.local && scope === null) return undefined;
  const root = laneVaultRoot(null);
  const lanes = storeLaneReadable(reach, scope);
  const cache: FrontmatterCache = new Map();
  return (rel) => {
    // A path that leaves the stand-in root names no record, and is
    // answered before anything is read.
    const path = resolve(root, rel);
    if (!pathIsInside(path, root)) return false;
    const page = underBrain(root, path) ? readLanePage(root, join(root, rel)) : null;
    if (page !== null) return lanes(page);
    return (
      isPathReadableAtReach(null, rel, reach, cache) &&
      (scope === null || isPathOwnerVisible(null, rel, scope, cache))
    );
  };
}

/**
 * The rule over a record-lane page kept as a store record: the same
 * `visibility:` and owner rules the vault check applies to a page's
 * frontmatter, read from the record's fields. Only called once the request
 * withholds something (remote reach, or the ownership gate on).
 */
function storeLaneReadable(
  reach: TransportReach,
  scope: string | null,
): (page: LanePage) => boolean {
  return (page) =>
    isRemotelyReadable(remoteDenyVisibilityTokens(page.frontmatter), reach) &&
    (scope === null || isOwnerVisible(pageOwner(page.frontmatter), scope));
}
