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

import { resolve } from "node:path";

import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { pathIsInside } from "../../core/path-safety.ts";
import { resolveOwnerScopeDelivery } from "../../core/brain/preferences-collect.ts";
import {
  isPathOwnerVisible,
  isPathReadableAtReach,
  type FrontmatterCache,
} from "../../core/search/result-filters.ts";
import { contextReach, type ServerContext } from "../tool-contract.ts";

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
  const scope = resolveOwnerScopeDelivery(ctx.vault, ctx.agentName).enforcedScope;
  if (reach === TRANSPORT_REACH.local && scope === null) return undefined;
  const root = resolve(ctx.vault);
  const cache: FrontmatterCache = new Map();
  return (rel) =>
    // A path that leaves the vault names no page the caller could be
    // shown, and is answered before anything is read.
    pathIsInside(resolve(root, rel), root) &&
    isPathReadableAtReach(ctx.vault, rel, reach, cache) &&
    (scope === null || isPathOwnerVisible(ctx.vault, rel, scope, cache));
}
