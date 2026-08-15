/**
 * Time helpers for the Brain layer. A true leaf: it imports nothing from
 * this repository, which is what lets every layer above depend on it
 * without closing a cycle (`tests/core/architecture/import-cycles.test.ts`).
 *
 * ## Formatting half
 *
 * These emit canonical UTC strings expected by the on-disk formats
 * (frontmatter, log headings, run ids):
 *
 *   - `isoSecond` → `YYYY-MM-DDTHH:MM:SSZ` (no sub-second precision).
 *     The log heading shape is `HH:MM:SS` only, so anything finer is
 *     silently dropped by `appendLogEvent`; truncating here keeps the
 *     return value consistent with what actually lands on disk.
 *   - `isoDate`   → `YYYY-MM-DD` (UTC calendar day).
 *
 * Both default to `new Date()` so callers can do `isoSecond()` without
 * threading the clock when they don't need determinism.
 *
 * ## Measurement half (evidence-at-the-boundary, unit B3)
 *
 * "How old is this file by wall clock, from its mtime" existed as five
 * independent copies, spelling one day three different ways
 * (`86_400_000`, `24 * 3600 * 1000`, `24 * 60 * 60 * 1000`) and - worse -
 * disagreeing about the stat failure. `profile-doc` treated it as stale,
 * `idea-discovery` returned age zero so an unreadable note read as brand
 * new, `stale-watch` let the raw `ENOENT` abort the whole scan. Three
 * policies for one event, none of them chosen at the site that had to
 * live with it.
 *
 * {@link fileAgeMs} therefore returns `null` and every caller must say
 * what it means. The rejected alternative was a discriminated result
 * (`{ ok: true, ageMs } | { ok: false, reason }`), which carries a named
 * reason but costs a shape and a guard at six call sites for a
 * distinction none of them acts on: absent and unreadable both mean
 * "this measurement did not happen", and the callers that want to name
 * the path already have it in hand. `null` is the smallest thing
 * `noUncheckedIndexedAccess`-grade strictness will not let a caller
 * ignore, and that unignorability is the whole point - a value that
 * cannot be silently averaged into an age. What is deliberately NOT
 * offered is a default-carrying overload: `fileAgeMs(path, now, 0)`
 * would rebuild the exact defect this unit removes.
 *
 * Neither function clamps a negative age. A file stamped in the future
 * is a real condition (clock skew, a copied mtime) and the callers that
 * want it floored - `weekly-brief`'s recency label - floor it themselves
 * where the floor is part of that surface's meaning, not of the
 * measurement.
 */

import { statSync } from "node:fs";

/**
 * Milliseconds in one day. The single spelling for every day-scale
 * conversion in the Brain layer; see the module docblock for the three
 * it replaced.
 */
export const MS_PER_DAY = 86_400_000;

/**
 * A duration in milliseconds as completed whole days, truncating the
 * partial day.
 *
 * Pure unit conversion, deliberately separate from {@link fileAgeMs}:
 * one of these can fail to measure and the other cannot, and folding
 * them into a single `fileAgeDays` would force the sub-day callers
 * (`profile-doc` gates on seconds) back onto their own arithmetic. It
 * takes a DURATION rather than a pair of instants because that is what
 * {@link fileAgeMs} hands back and what four of the five re-pointed
 * sites already had; a two-instant signature would have made each of
 * them spell the subtraction again, which is half of what was
 * duplicated. Negative for a negative duration; see the module docblock.
 */
export function msToWholeDays(durationMs: number): number {
  return Math.floor(durationMs / MS_PER_DAY);
}

/**
 * Wall-clock age of the file at `path` in milliseconds, measured from
 * its mtime against the caller-supplied `nowMs`.
 *
 * `null` means the age could not be measured at all - the path is
 * absent, or it exists behind a directory that denies traversal. It is
 * NOT an age, and no caller may treat it as one; see the module
 * docblock for why this is a `null` rather than a discriminated result
 * and why there is no default-carrying overload.
 *
 * `nowMs` is required rather than defaulted so a caller that already
 * holds a pinned clock cannot accidentally measure against a second,
 * later one mid-scan.
 */
export function fileAgeMs(path: string, nowMs: number): number | null {
  try {
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

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
