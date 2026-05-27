/**
 * Per-page `lifecycle` axis - tracks each vault page's verification
 * state independently of the preference `status` axis (which is
 * promoted-state for a rule, not freshness for a page).
 *
 * Values, ordered loosely from "least vetted" to "no longer trusted":
 *
 *   - `draft`      - first capture, not yet promoted or verified.
 *   - `stable`     - has been around long enough to count as normal.
 *   - `verified`   - operator or an auto-rule explicitly confirmed
 *                    the content matches reality.
 *   - `deprecated` - superseded by another page (`merged_into` or a
 *                    successor link); keep readable but don't trust.
 *   - `archived`   - moved out of the live working set; long-term
 *                    storage only.
 *   - `disputed`   - flagged by health checks as contradictory or
 *                    contested by another vault entry.
 *
 * Default lifecycle for newly-introduced fields is `stable` so any
 * legacy page without the field stays valid without a migration step.
 * New writes pick the most appropriate stage for the call site.
 */

export const PAGE_LIFECYCLE = Object.freeze({
  draft: "draft",
  stable: "stable",
  verified: "verified",
  deprecated: "deprecated",
  archived: "archived",
  disputed: "disputed",
} as const);

export type PageLifecycle = (typeof PAGE_LIFECYCLE)[keyof typeof PAGE_LIFECYCLE];

const ALL: ReadonlySet<string> = new Set(Object.values(PAGE_LIFECYCLE));

export function isPageLifecycle(value: unknown): value is PageLifecycle {
  return typeof value === "string" && ALL.has(value);
}

/**
 * Read `_lifecycle` (or legacy `lifecycle`) from a frontmatter map.
 * Unknown / absent values fall back to `stable` per the
 * backwards-compatibility contract.
 */
export function readLifecycle(meta: Readonly<Record<string, unknown>>): PageLifecycle {
  const modern = meta["_lifecycle"];
  if (isPageLifecycle(modern)) return modern;
  const legacy = meta["lifecycle"];
  if (isPageLifecycle(legacy)) return legacy;
  return PAGE_LIFECYCLE.stable;
}

/**
 * Pages older than the staleness cap that are still in `stable` or
 * `draft` are candidates for lifecycle demotion or re-verification.
 * `verified` and `deprecated` are never reported stale - they carry
 * their own provenance and should not bounce just because the file is old.
 *
 * `ageDays` is measured against `created_at` or `last_evidence_at`;
 * the caller picks which timestamp matters in context.
 */
export const PAGE_STALE_DAYS_DEFAULT = 180;

export function isStale(
  lifecycle: PageLifecycle,
  ageDays: number,
  thresholdDays: number = PAGE_STALE_DAYS_DEFAULT,
): boolean {
  if (ageDays < thresholdDays) return false;
  return lifecycle === PAGE_LIFECYCLE.stable || lifecycle === PAGE_LIFECYCLE.draft;
}

/**
 * Convert an ISO-8601 timestamp string into age-in-days against a
 * reference point. Returns `Infinity` when the timestamp is missing
 * or unparseable so the staleness predicate trips loud on bad input.
 */
export function ageDaysFromIso(iso: string | null | undefined, now: Date): number {
  if (!iso) return Infinity;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return Infinity;
  const deltaMs = now.getTime() - ts;
  return deltaMs / (24 * 60 * 60 * 1000);
}
