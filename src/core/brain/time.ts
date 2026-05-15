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
