/**
 * Time helpers for the Brain layer.
 *
 * Both functions emit canonical UTC strings expected by the on-disk
 * formats (frontmatter, log headings, run ids):
 *
 *   - `isoSecond` → `YYYY-MM-DDTHH:MM:SSZ` (no sub-second precision).
 *     The log heading shape is `HH:MM:SS` only, so anything finer is
 *     silently dropped by `appendLogEvent`; truncating here keeps the
 *     return value consistent with what actually lands on disk.
 *   - `isoDate`   → `YYYY-MM-DD` (UTC calendar day).
 *
 * Both default to `new Date()` so callers can do `isoSecond()` without
 * threading the clock when they don't need determinism.
 */

/** ISO-8601 UTC at whole-second precision (`YYYY-MM-DDTHH:MM:SSZ`). */
export function isoSecond(d: Date = new Date()): string {
  // `Date#toISOString` always emits `YYYY-MM-DDTHH:MM:SS.sssZ`; strip
  // the milliseconds segment in-place to land on the canonical shape.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** ISO-8601 UTC calendar day (`YYYY-MM-DD`). */
export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compact UTC run-id stamp (`YYYY-MM-DD-HHMMSS`). Whole-second
 * precision, no separators inside the time-of-day segment, so the
 * result is a filesystem-safe run-id stem under
 * {@link validateRunId} (`[A-Za-z0-9][A-Za-z0-9._-]*`). Shared by the
 * `dream` run-id formatter and the destructive-snapshot gate so both
 * mint ids the same way.
 */
export function compactRunStamp(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}${mi}${ss}`;
}

/**
 * Render the gap between an ISO-8601 timestamp and `now` as a short,
 * human-readable relative-age label — "just now", "3m ago", "2h ago",
 * "5d ago", "2w ago", "3mo ago", "1y ago". Used by session-start
 * surfaces (the morning brief's typed recent-activity timeline) so an
 * operator can scan recency at a glance without parsing absolute times.
 *
 * Deterministic given the two timestamps. A future `isoTimestamp` clamps
 * to "just now" so a clock skew cannot produce a nonsensical "-3m ago".
 * Returns the empty string for an unparseable input so call sites can
 * omit the label without a try/catch at every one of them.
 *
 * Accepts both whole-second ISO (`2026-05-01T00:00:00Z`) and calendar-day
 * (`2026-05-01`) shapes; `Date.parse` handles both.
 */
export function relativeAge(isoTimestamp: string, now: Date = new Date()): string {
  const ts = Date.parse(isoTimestamp);
  if (Number.isNaN(ts)) return "";
  let diffMs = now.getTime() - ts;
  if (diffMs < 0) diffMs = 0;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (day < 365) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}
