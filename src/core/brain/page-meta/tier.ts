/**
 * Per-page importance tier - operator intent about which pages
 * matter most. Unlike `lifecycle` (freshness / verification) and
 * `_confidence` (dream-computed probability), `tier` is user-owned
 * and stays unprefixed in frontmatter so Obsidian users can edit it
 * by hand without violating the Group-C-fields convention.
 *
 * Default is `supporting`, picked so the search ranker stays
 * bit-identical for any vault that has not yet been tier-tagged.
 */

export const PAGE_TIER = Object.freeze({
  core: "core",
  supporting: "supporting",
  peripheral: "peripheral",
} as const);

export type PageTier = (typeof PAGE_TIER)[keyof typeof PAGE_TIER];

const ALL: ReadonlySet<string> = new Set(Object.values(PAGE_TIER));

export function isPageTier(value: unknown): value is PageTier {
  return typeof value === "string" && ALL.has(value);
}

export const PAGE_TIER_DEFAULT: PageTier = PAGE_TIER.supporting;

/**
 * Read `tier` from a frontmatter map. Defaults to `supporting`.
 * Unrecognised values also fall back to the default so a typo
 * (`tier: cor`) does not silently disable a page.
 */
export function readTier(meta: Readonly<Record<string, unknown>>): PageTier {
  const v = meta["tier"];
  if (isPageTier(v)) return v;
  return PAGE_TIER_DEFAULT;
}

/**
 * Multiplicative ranker weight for each tier. `supporting` is the
 * identity (1.0) so untagged vaults do not change their ranking; the
 * other two values bracket it in a deliberately small range so tier
 * cannot dominate raw keyword / semantic relevance.
 */
const TIER_WEIGHT: Readonly<Record<PageTier, number>> = Object.freeze({
  core: 1.4,
  supporting: 1.0,
  peripheral: 0.6,
});

export function tierWeight(tier: PageTier): number {
  return TIER_WEIGHT[tier];
}
