/**
 * The title claim and the slot reservations of a pledge create below local
 * reach (change `lane-reach-residuals`, package 8, design R8): read on the
 * fold of every partition with the caller's own reach predicate widened to
 * every entry held in `private` (`wideReadableAtReach`), so the create
 * lands where a local caller's would, or is refused with the fixed answer
 * when only a private pledge decides it.
 *
 * Each answer carries whether the caller's own view makes the same
 * decision: a claim or a reservation it does not make is held in
 * `private`, and the create never names it (a refusal becomes the fixed
 * answer; a skipped slot sets the private hold the ladder reports when
 * every slot is taken). At local reach the caller's own decision is the
 * only one read, as before.
 *
 * The decisions themselves stay in `pledges.ts`, handed in as functions of
 * the predicate, so this module does not read the pledge folder itself.
 * The pages a create is refused for ({@link pledgeCreateMatches}, moved
 * here by package 16, design R14) are read the same way, through the
 * folder's reads handed in as {@link PledgeIdentityReads}.
 */

import { basename } from "node:path";

import { privateWithheld, withPrivateShown } from "../store/caller-reach.ts";
import { lanePageExists } from "../store/lane-pages.ts";
import { wideReadableAtReach } from "../store/lane-reach-guard.ts";

/** A reach predicate over vault-relative POSIX paths. */
type ReadableRel = (rel: string) => boolean;

/** A title claim, as `pledgeTitleClaim` answers it. */
export interface PledgeTitleClaim {
  readonly kind: "refuse" | "base";
  readonly slug: string;
}

/** A decision of the identity rule, and whether only a private pledge makes it. */
export interface DecidedAtReach<T> {
  readonly value: T;
  /** The caller's own view does not make this decision: a private pledge does. */
  readonly privateOnly: boolean;
}

/**
 * The title claim of a create of a pledge, `claimOf` read with the
 * caller's identity rule on the fold of every partition below local reach;
 * `privateOnly` when the caller's own view answers another claim.
 */
export function titleClaimAtReach(
  vault: string,
  readable: ReadableRel | undefined,
  claimOf: (readable: ReadableRel | undefined) => PledgeTitleClaim | null,
): DecidedAtReach<PledgeTitleClaim | null> {
  if (!privateWithheld()) return { value: claimOf(readable), privateOnly: false };
  const wide = wideReadableAtReach(vault, readable);
  const claim = withPrivateShown(() => claimOf(wide));
  if (claim === null) return { value: null, privateOnly: false };
  const own = claimOf(readable);
  return {
    value: claim,
    privateOnly: own === null || own.kind !== claim.kind || own.slug !== claim.slug,
  };
}

/**
 * Whether a slot of the create's ladder is reserved, `reservedOf` read
 * with the caller's identity rule on the fold of every partition below
 * local reach; `privateOnly` when the caller's own view finds it free.
 */
export function slotReservedAtReach(
  vault: string,
  readable: ReadableRel | undefined,
  reservedOf: (readable: ReadableRel | undefined) => boolean,
): DecidedAtReach<boolean> {
  if (!privateWithheld()) return { value: reservedOf(readable), privateOnly: false };
  const wide = wideReadableAtReach(vault, readable);
  if (!withPrivateShown(() => reservedOf(wide))) return { value: false, privateOnly: false };
  return { value: true, privateOnly: !reservedOf(readable) };
}

/** The reads of the pledge folder {@link pledgeCreateMatches} needs, owned by `pledges.ts`. */
export interface PledgeIdentityReads {
  /** The canonical identity of a promise. */
  readonly identity: (title: string, due: string, source: string) => string;
  /** A readable pledge of this identity at any stored stem. */
  readonly findByIdentity: (
    vault: string,
    title: string,
    due: string,
    source: string,
    readable: ReadableRel | undefined,
  ) => { readonly path: string } | null;
  /** The title claim of a create. */
  readonly titleClaim: (
    vault: string,
    title: string,
    readable: ReadableRel | undefined,
  ) => PledgeTitleClaim | null;
  /** The slugs one pledge may occupy, in preference order. */
  readonly slugCandidates: (title: string, due: string, source: string) => ReadonlyArray<string>;
  /** The page path of a slug. */
  readonly path: (vault: string, slug: string) => string;
  /** The pledge stored at a slug, or null when it cannot be read as one. */
  readonly parse: (
    vault: string,
    slug: string,
  ) => { readonly title: string; readonly due: string; readonly source: string } | null;
}

/**
 * The pledge pages a create of `(title, due, source)` would be refused for,
 * as `createPledgePage` decides: the pledge of the same identity at any
 * stem, a pledge whose listed slug the title is, a candidate slot holding
 * the same identity or a page unreadable as a pledge.
 */
export function pledgeCreateMatches(
  vault: string,
  title: string,
  due: string,
  source: string,
  readable: ReadableRel | undefined,
  reads: PledgeIdentityReads,
): string[] {
  const identity = reads.identity(title, due, source);
  const same = reads.findByIdentity(vault, title, due, source, readable);
  const named = reads.titleClaim(vault, title, readable);
  return [
    ...(same === null ? [] : [same.path]),
    ...(named?.kind === "refuse" ? [reads.path(vault, named.slug)] : []),
    ...reads
      .slugCandidates(title, due, source)
      .map((slug) => reads.path(vault, slug))
      .filter((path) => sameIdentityAt(vault, path, identity, reads)),
  ];
}

/** Whether the lane page at `path` stores a pledge of `identity`, or is unreadable as one. */
function sameIdentityAt(
  vault: string,
  path: string,
  identity: string,
  reads: PledgeIdentityReads,
): boolean {
  if (!lanePageExists(vault, path)) return false;
  const stored = reads.parse(vault, basename(path, ".md"));
  return stored === null || reads.identity(stored.title, stored.due, stored.source) === identity;
}
