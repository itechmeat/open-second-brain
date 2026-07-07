/**
 * Caller-settable per-memory expiration (C5 / t_a82b674e).
 *
 * A caller can stamp an explicit `expiration_date` on a preference or
 * signal at write time. The default read/list path silently drops
 * memories past their date; an opt-in `showExpired` flag re-includes
 * them for audit. This is orthogonal to dream's heuristic retirement —
 * an expired-by-date memory is FILTERED on read, never moved to
 * `Brain/retired/` (the audit trail is preserved on disk).
 *
 * LLM-free and deterministic: the whole feature is a frontmatter date
 * plus a date comparison. Two granularities are supported:
 *
 *   - a date-only `YYYY-MM-DD` value keeps the memory live through the
 *     END of that UTC day, so "use the staging endpoint until
 *     2026-07-15" stays live all of the 15th and lapses on the 16th;
 *   - a full ISO-8601 timestamp expires at that exact instant.
 */

/** Frontmatter key carrying the caller-supplied expiration. */
export const EXPIRATION_DATE_FIELD = "expiration_date";

/** `YYYY-MM-DD` with no time component. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + normalise a caller-supplied expiration date. Accepts a
 * date-only `YYYY-MM-DD` or a full ISO-8601 timestamp; returns the
 * trimmed value. Throws on an empty or unparseable value so a bad date
 * is rejected at write time rather than silently hiding a memory (or
 * silently never expiring one) on read.
 */
export function normalizeExpirationDate(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("expiration_date must not be empty");
  }
  if (expirationBoundaryMs(trimmed) === null) {
    throw new Error(
      `expiration_date must be a YYYY-MM-DD date or ISO-8601 timestamp; got ${JSON.stringify(raw)}`,
    );
  }
  return trimmed;
}

/**
 * The last instant (epoch ms) at which a memory carrying this expiration
 * is still live. Date-only → end of that UTC day; full timestamp → the
 * parsed instant. Returns `null` when the value cannot be parsed as
 * either — the caller decides whether that is a hard error (write) or a
 * fail-open (read).
 */
function expirationBoundaryMs(expiration: string): number | null {
  const value = expiration.trim();
  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    // Reject impossible calendar dates (e.g. 2026-13-40) — Date.UTC
    // would otherwise roll them over into an adjacent month.
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (
      utc.getUTCFullYear() !== year ||
      utc.getUTCMonth() !== month - 1 ||
      utc.getUTCDate() !== day
    ) {
      return null;
    }
    return Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * True when a memory carrying `expiration_date` is past its expiration
 * relative to `now`. A value that cannot be parsed fails OPEN (returns
 * `false` — not expired) so a hand-corrupted date never silently hides a
 * memory; surfacing that corruption is the doctor's job, not this
 * filter's.
 */
export function isExpired(expiration_date: string, now: Date): boolean {
  const boundary = expirationBoundaryMs(expiration_date);
  if (boundary === null) return false;
  return now.getTime() > boundary;
}

/** A memory that may carry an optional expiration date. */
export interface ExpirableMemory {
  readonly expiration_date?: string;
}

export interface FilterExpiredOptions {
  /** Wall clock the expiration is compared against. Defaults to `new Date()`. */
  readonly now?: Date;
  /** When true, expired memories are kept (audit / recall of lapsed memories). */
  readonly showExpired?: boolean;
}

/**
 * Drop memories past their `expiration_date`. Memories with no
 * `expiration_date` are always kept. When `showExpired` is set, nothing
 * is dropped (the full list is returned, order-preserved).
 */
export function filterExpired<T extends ExpirableMemory>(
  items: ReadonlyArray<T>,
  options: FilterExpiredOptions = {},
): T[] {
  if (options.showExpired) return [...items];
  const now = options.now ?? new Date();
  return items.filter(
    (item) => item.expiration_date === undefined || !isExpired(item.expiration_date, now),
  );
}
