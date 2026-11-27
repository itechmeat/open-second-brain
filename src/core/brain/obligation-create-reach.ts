/**
 * The identity decisions of an obligation create (moved out of
 * `obligations.ts` by change `lane-reach-residuals`, package 16, design
 * R14; the rules themselves are 2.0.4's): the pages an add is refused for,
 * and the slot a derived obligation (a decision's review) is filed at.
 * Both are read with a reach predicate the caller hands in, so the reach
 * guard can take them on the fold of every partition below local reach.
 *
 * The reads of the obligation folder stay in `obligations.ts`, handed in
 * as {@link ObligationIdentityReads}, so this module does not read the
 * folder itself and imports nothing from that module.
 */

import { titleIdentity, titleSlug } from "../vault.ts";
import { obligationPath } from "./paths.ts";
import { lanePageExists } from "../store/lane-pages.ts";

/** A reach predicate over vault-relative POSIX paths. */
type ReadableRel = (rel: string) => boolean;

/** An obligation page a title or a listed slug names, as the folder's lookup locates it. */
export interface LocatedObligation {
  /** The page's stem, or the value's own slug when no page matched. */
  readonly slug: string;
  /** The stored title, and the obligation read from it (null when its cadence cannot be read). */
  readonly page: { readonly title: string; readonly page: unknown } | null;
}

/** The reads of the obligation folder the decisions below need, owned by `obligations.ts`. */
export interface ObligationIdentityReads {
  /** The page a title or a listed slug names, at the caller's reach. */
  readonly locate: (
    vault: string,
    value: string,
    readable: ReadableRel | undefined,
  ) => LocatedObligation;
  /** The slug of the active obligation an add of the title would collide with. */
  readonly existingSlug: (
    vault: string,
    title: string,
    readable: ReadableRel | undefined,
  ) => string | null;
  /** Whether a readable obligation title already reserves this listed stem. */
  readonly reserved: (vault: string, stem: string, readable: ReadableRel | undefined) => boolean;
  /** The identity-suffixed slots of a title, in the order a derived obligation tries them. */
  readonly suffixedSlots: (title: string) => string[];
  /** The refusal of an obligation whose cadence cannot be read. */
  readonly unreadable: (slug: string) => Error;
}

/**
 * The obligation pages an add of `title` (at `slot`, when planned) would
 * be refused for, as `addObligation` decides: the page at the slot or the
 * slug, a page storing the exact title, a slot another title reserves.
 */
export function addMatches(
  vault: string,
  title: string,
  slot: string | undefined,
  readable: ReadableRel | undefined,
  reads: ObligationIdentityReads,
): string[] {
  const slugs: string[] = [];
  const exact = reads.locate(vault, title, readable);
  if (exact.page !== null && titleIdentity(exact.page.title) === titleIdentity(title)) {
    slugs.push(exact.slug);
  }
  if (slot !== undefined && slot !== titleSlug(title)) {
    if (lanePageExists(vault, obligationPath(vault, slot))) slugs.push(slot);
    const reserved = reads.locate(vault, slot, readable);
    if (reserved.page !== null && titleIdentity(reserved.page.title) === titleIdentity(slot)) {
      slugs.push(reserved.slug);
    }
  } else {
    const existing = reads.existingSlug(vault, title, readable);
    if (existing !== null) slugs.push(existing);
  }
  return slugs.map((s) => obligationPath(vault, s));
}

/**
 * Where a derived obligation titled `title` is filed, read with
 * `readable` (`obligationSlotPlan` in `obligations.ts` names the rule):
 * the obligation that stores exactly this title (`existing: true`); else
 * its own slug when nothing holds it; else the first free
 * identity-suffixed slot; null when every slot is held. Throws the
 * folder's refusal when the obligation that stores the title cannot be
 * read as one.
 */
export function slotPlanOf(
  vault: string,
  title: string,
  readable: ReadableRel | undefined,
  reads: ObligationIdentityReads,
): { readonly slug: string; readonly existing: boolean } | null {
  const located = reads.locate(vault, title, readable);
  if (located.page !== null && titleIdentity(located.page.title) === titleIdentity(title)) {
    // Reused only when it is an obligation `list`, `show` and `done` can
    // act on: a page that stores the title but whose cadence cannot be read
    // would answer a decision's review that never comes due.
    if (located.page.page === null) throw reads.unreadable(located.slug);
    return { slug: located.slug, existing: true };
  }
  if (reads.existingSlug(vault, title, readable) === null) {
    return { slug: titleSlug(title.trim()), existing: false };
  }
  for (const slot of reads.suffixedSlots(title)) {
    if (
      !lanePageExists(vault, obligationPath(vault, slot)) &&
      !reads.reserved(vault, slot, readable)
    ) {
      return { slug: slot, existing: false };
    }
  }
  return null;
}
