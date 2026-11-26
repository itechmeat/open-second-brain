/**
 * May the caller of one request read a vault page at this path?
 *
 * A tool that reads a page's bytes on the caller's behalf and answers
 * something derived from them - whether a span occurs in it, which
 * capture scope it backs - must answer at the caller's reach, or the
 * derived answer discloses what the page itself would not. This module
 * binds the per-path rules to one request:
 *
 *   - visibility: `isPathReadableAtReach` at the reach the transport
 *     minted (`contextReach`, fail closed when none was minted);
 *   - ownership: `isPathOwnerVisible` under the server-resolved identity,
 *     only when `integrity.owner_scope_delivery` is `fail` (the same gate
 *     `gatedOwnerScopeView` reads);
 *   - partition: below local reach, a lane page the store holds in its
 *     `private` partition is withheld, whatever its frontmatter says
 *     (`laneEntryInPrivate`, the answer the reference view already
 *     gives): private-partition lane entries are withheld below local
 *     reach.
 *
 * On a machine whose lane pages live in the store, a `Brain/` path that
 * names a lane entry is judged by its record; a `Brain/` path that names
 * no lane entry is judged by the vault rules (with no vault, the store
 * record rules), as any path outside `Brain/` is, and any other failure
 * of the lane read withholds the page. The request's config path selects
 * the store, as it does for the server.
 *
 * The predicate is a plain vault-relative path test rather than an
 * `ArtifactRefView`, because the reference view reads a path without a
 * `.md` extension as a Brain artifact id, and a source path may name any
 * vault file.
 */

import { join, relative, resolve, sep } from "node:path";

import { isOwnerVisible, pageOwner } from "../../core/graph/agent-scope.ts";
import { remoteDenyVisibilityTokens } from "../../core/graph/privacy-markers.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../core/graph/transport-reach.ts";
import { isRemotelyReadable } from "../../core/graph/visibility.ts";
import {
  laneEntryInPrivate,
  lanePagesInStore,
  laneVaultRoot,
  readLanePage,
  type LanePage,
} from "../../core/store/lane-pages.ts";
import { BRAIN_ROOT_REL } from "../../core/brain/path-constants.ts";
import { storeLaneEntryAt } from "../../core/brain/artifact-ref-resolve.ts";
import { lanePlaceOf } from "../../core/store/lane-paths.ts";
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
  const configPath = ctx.configPath ?? undefined;
  if (!lanePagesInStore(vault, configPath)) return inVault;
  // A store-only machine: a record-lane page under `Brain/` is a store
  // record, measured from its fields; any other path (a memory page, a
  // vault note, a `Brain/` file no lane keeps) is judged by the vault
  // rules. Containment is answered first, so a traversing path reads
  // nothing.
  const lanes = storeLaneReadable(reach, scope, vault, configPath);
  return (rel) => {
    const path = resolve(root, rel);
    if (!pathIsInside(path, root)) return false;
    const page = lanePageAt(root, vault, path, configPath);
    if (page === undefined) return false;
    if (page !== null) return lanes(page);
    // Below local reach the caller's fold shows no `private` entry: a
    // file at a lane path (a frozen predecessor) answers only for an
    // entry the fold of every partition definitively does not hold.
    if (reach !== TRANSPORT_REACH.local && withheldLanePath(root, vault, path, configPath)) {
      return false;
    }
    return inVault(rel);
  };
}

/**
 * Whether the lane path `path` (already inside `root`) names an entry the
 * fold of every partition holds in `private`, removed by a record held in
 * `private`, or may hold there (that fold may miss a record, or the
 * question failed): false for a path that names no lane entry.
 */
function withheldLanePath(
  root: string,
  laneRoot: string,
  path: string,
  configPath: string | undefined,
): boolean {
  if (!underBrain(root, path)) return false;
  const rel = relative(root, path).split(sep).join("/");
  if (lanePlaceOf(rel.slice(BRAIN_ROOT_REL.length + 1)) === null) return false;
  return storeLaneEntryAt(laneRoot, rel, configPath)?.private === true;
}

/**
 * The lane page at `path` (already inside `root`): `null` when the path
 * is outside `Brain/`, names no lane entry or the store holds none there,
 * so the caller judges it by the other rules; `undefined` when the lane
 * read fails, so the page is withheld (fail closed).
 */
function lanePageAt(
  root: string,
  laneRoot: string,
  path: string,
  configPath: string | undefined,
): LanePage | null | undefined {
  if (!underBrain(root, path)) return null;
  const brainRel = relative(join(root, BRAIN_ROOT_REL), path).split(sep).join("/");
  if (lanePlaceOf(brainRel) === null) return null;
  try {
    return readLanePage(laneRoot, join(laneRoot, relative(root, path)), configPath);
  } catch {
    return undefined;
  }
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
  const configPath = ctx.configPath ?? undefined;
  const lanes = storeLaneReadable(reach, scope, root, configPath);
  const cache: FrontmatterCache = new Map();
  return (rel) => {
    // A path that leaves the stand-in root names no record, and is
    // answered before anything is read.
    const path = resolve(root, rel);
    if (!pathIsInside(path, root)) return false;
    const page = lanePageAt(root, root, path, configPath);
    if (page === undefined) return false;
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
 * frontmatter, read from the record's fields, and - below local reach -
 * the partition the store holds the entry in. An entry the store holds in
 * `private` is withheld whatever its fields say, so a caller below local
 * reach sees the same entry the reference view withholds. Only called once
 * the request withholds something (remote reach, or the ownership gate
 * on). Each question reads the fold once (a cache hit after a fingerprint
 * check), so no verdict is kept between questions: one kept as shared
 * could go stale when the fold becomes incomplete inside one request.
 */
function storeLaneReadable(
  reach: TransportReach,
  scope: string | null,
  root: string,
  configPath: string | undefined,
): (page: LanePage) => boolean {
  const withheldByPartition = (path: string): boolean => {
    try {
      return laneEntryInPrivate(root, path, configPath);
    } catch {
      // The partition cannot be determined, so the entry is withheld
      // (fail closed), as the reference view withholds it.
      return true;
    }
  };
  return (page) => {
    if (reach !== TRANSPORT_REACH.local && withheldByPartition(page.path)) return false;
    return (
      isRemotelyReadable(remoteDenyVisibilityTokens(page.frontmatter), reach) &&
      (scope === null || isOwnerVisible(pageOwner(page.frontmatter), scope))
    );
  };
}
