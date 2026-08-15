/**
 * When a declared `authored_at` is usable as an authoring instant.
 *
 * One rule, two boundaries. The indexer applies it when it reads the
 * frontmatter, so `documents.authored_at` keeps meaning "an instant this
 * content was authored at"; the ranker applies it again when it reads that
 * column, because a database this release does not rewrite can already hold
 * a value the rule refuses, and the content-hash fastpath means a poisoned
 * row can outlive many index runs without ever being re-read.
 *
 * The two refusals are deliberately NOT the same disposition. The index
 * DROPS the value (a re-index recovers it once the declared instant is in
 * the past); the ranker leaves the stored value alone and simply declines to
 * measure freshness from it. Neither invents a substitute instant.
 *
 * Pure and injectable: the caller passes the clock, so nothing here reads
 * `Date.now()` and the ranker stays a pure function of its inputs.
 */

/**
 * The declared instant when it can be an authoring instant, else `null`.
 *
 * Two refusals, both structural:
 *
 *   - **at or before the Unix epoch** - the import layer's "no timestamp"
 *     sentinel, never a real authoring instant;
 *   - **after the reading clock** - content cannot have been authored after
 *     the moment something read it. Unclamped, such a value pinned a
 *     document at maximum freshness permanently: the decay curve returns its
 *     full amplitude for any non-positive age, and no passage of time moves a
 *     date in the year 2999.
 *
 * A refusal returns `null` rather than a substituted instant, so each caller
 * decides what absence means for it - `mtime` for the freshness anchor, an
 * omitted field on a result, no participation in the chronology tie-break.
 * Clamping to the reading clock instead would leave the document at the top
 * of the freshness curve forever, which is the defect rather than its fix.
 */
export function usableAuthoredAtSeconds(
  authoredAtSeconds: number | null | undefined,
  nowMs: number,
): number | null {
  if (authoredAtSeconds === null || authoredAtSeconds === undefined) return null;
  if (!Number.isFinite(authoredAtSeconds) || authoredAtSeconds <= 0) return null;
  if (authoredAtSeconds * 1000 > nowMs) return null;
  return authoredAtSeconds;
}

/**
 * Parse a raw frontmatter `authored_at` value into a usable instant in unix
 * seconds, or `null`. Tolerant by design: a malformed value never fails
 * indexing, it just leaves the document with no authoring instant, so it
 * ranks exactly as a note that declared none.
 */
export function parseAuthoredAtSeconds(raw: unknown, nowMs: number): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return null;
  return usableAuthoredAtSeconds(Math.floor(ms / 1000), nowMs);
}
