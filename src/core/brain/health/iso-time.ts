/**
 * Shared ISO-8601 parsing for the semantic-health detectors.
 *
 * `stale-claim.ts` and `batch-inflation.ts` each grew an identical
 * `parseIsoUtc` helper because both compare stored `YYYY-MM-DD` or full
 * timestamps against a clock. The acknowledge-before watermark is a
 * third consumer (config validation plus the reconcile filter), so the
 * logic moves here as one source of truth rather than a fourth copy.
 */

/** Date-only ISO form (`YYYY-MM-DD`), which the doctor's checkIso allows. */
export const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an ISO timestamp deterministically. A date-only value is
 * expanded to UTC midnight before parsing so the millisecond result is
 * identical on every engine and peer, never drifting to a local-midnight
 * interpretation. Returns `NaN` for an unparseable value.
 */
export function parseIsoUtc(value: string): number {
  const iso = ISO_DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
  return Date.parse(iso);
}

/**
 * True when `value` is a parseable date-only (`YYYY-MM-DD`) or full ISO
 * timestamp. Used to reject an invalid watermark loudly instead of
 * silently treating it as absent.
 */
export function isValidIsoInstant(value: string): boolean {
  return Number.isFinite(parseIsoUtc(value));
}
