/**
 * Timezone presentation layer (t_2ccadc6a,
 * upstream:tencentdb-agent-memory).
 *
 * Storage timestamps stay canonical UTC everywhere - frontmatter, log
 * headings, run ids, metrics (`time.ts` is untouched). This module
 * converts ONE instant at the presentation boundary: user-facing CLI
 * output and LLM-facing MCP envelopes render the operator's configured
 * IANA zone (`timezone` config field / `VAULT_TIMEZONE` env, resolved
 * by `resolveTimezone()` in core/config.ts).
 *
 * Output shape is the full-offset ISO-8601 form
 * `YYYY-MM-DDTHH:MM:SS+HH:MM` so a reader always sees both the local
 * wall time and how far it sits from the stored UTC value. Fail-soft:
 * a missing or invalid zone renders the canonical UTC `Z` form, and an
 * unparseable instant is returned verbatim - presentation must never
 * break the surface it decorates.
 */

const PART_TYPES = ["year", "month", "day", "hour", "minute", "second"] as const;

/**
 * Render one ISO-8601 UTC instant in the given IANA zone with an
 * explicit offset. `tz === null` (not configured) or an invalid zone
 * returns the canonical UTC `Z` rendering of the same instant.
 */
export function formatLocalTimestamp(isoUtc: string, tz: string | null): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return isoUtc;
  const canonical = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (tz === null) return canonical;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
  } catch {
    return canonical;
  }

  const v: Record<string, string> = {};
  for (const part of parts) {
    if ((PART_TYPES as ReadonlyArray<string>).includes(part.type)) v[part.type] = part.value;
  }
  // `hour12: false` can render midnight as "24" in some engines.
  const hour = v["hour"] === "24" ? "00" : v["hour"]!;

  // Offset = local wall clock reinterpreted as UTC minus the instant.
  const wallAsUtc = Date.UTC(
    Number(v["year"]),
    Number(v["month"]) - 1,
    Number(v["day"]),
    Number(hour),
    Number(v["minute"]),
    Number(v["second"]),
  );
  const offsetMinutes = Math.round((wallAsUtc - date.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;

  return `${v["year"]}-${v["month"]}-${v["day"]}T${hour}:${v["minute"]}:${v["second"]}${offset}`;
}
