/**
 * Filesystem paths and date utilities for the Pay Memory layout.
 *
 * The layout sits inside `<vault>/AI Wiki/`:
 *   - policies/spending.md
 *   - payments/YYYY-MM-DD/<slug>.md
 *   - assets/<slug>.md
 *   - drafts/<slug>.md       (written by other tools — kept here for completeness)
 *   - reports/<slug>.md
 *
 * Date subdirectories use the hyphenated `YYYY-MM-DD` form (ISO 8601 calendar
 * date). This intentionally differs from the dotted `YYYY.MM.DD` used by the
 * Daily event log — the two systems are independent.
 */

import { join } from "node:path";

export {
  ensureInsideVault,
  vaultRelative,
} from "../path-safety.ts";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^(\d{2}):(\d{2})$/;

export interface PayMemoryDirs {
  readonly policies: string;
  readonly payments: string;
  readonly assets: string;
  readonly drafts: string;
  readonly reports: string;
}

export function payMemoryDirs(vault: string): PayMemoryDirs {
  const root = join(vault, "AI Wiki");
  return {
    policies: join(root, "policies"),
    payments: join(root, "payments"),
    assets: join(root, "assets"),
    drafts: join(root, "drafts"),
    reports: join(root, "reports"),
  };
}

export function policyPath(vault: string): string {
  return join(payMemoryDirs(vault).policies, "spending.md");
}

export function paymentsDateDir(vault: string, date: string): string {
  return join(payMemoryDirs(vault).payments, validateIsoDate(date));
}

export function receiptPath(vault: string, date: string, slug: string): string {
  return join(paymentsDateDir(vault, date), `${validateSlug(slug)}.md`);
}

export function assetPath(vault: string, slug: string): string {
  return join(payMemoryDirs(vault).assets, `${validateSlug(slug)}.md`);
}

export function reportPath(vault: string, slug: string): string {
  return join(payMemoryDirs(vault).reports, `${validateSlug(slug)}.md`);
}

/**
 * Reject slugs that could escape the intended Pay Memory subdirectory or
 * (under `..` traversal) silently land elsewhere in the vault.
 *
 * `ensureInsideVault` would still catch a slug that resolves outside the
 * vault root, but a slug like `../etc/passwd` resolves to a sibling vault
 * directory which is technically inside the vault — defense in depth.
 */
export function validateSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed) throw new Error("slug must not be empty");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`slug must not contain path separators: ${slug}`);
  }
  if (trimmed === ".." || trimmed === "." || /(?:^|[^\w])\.\.(?:$|[^\w])/.test(trimmed)) {
    throw new Error(`slug must not contain '..' traversal: ${slug}`);
  }
  return trimmed;
}

/** Validate `YYYY-MM-DD`. Throws on bad shape or invalid calendar date. */
export function validateIsoDate(value: string): string {
  const m = ISO_DATE_RE.exec(value);
  if (!m) {
    throw new Error("payment date must use YYYY-MM-DD format");
  }
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  const day = parseInt(m[3]!, 10);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error(`payment date is not a valid calendar date: ${value}`);
  }
  return value;
}

/** Validate `HH:MM` 24-hour time. Throws on bad shape. Mirrors event-log. */
export function validateIsoTime(value: string): string {
  const m = HHMM_RE.exec(value);
  if (!m) {
    throw new Error("payment time must use HH:MM 24-hour format");
  }
  const hour = parseInt(m[1]!, 10);
  const minute = parseInt(m[2]!, 10);
  if (hour > 23 || minute > 59) {
    throw new Error(
      `payment time out of range: ${value} (hour must be 0-23, minute 0-59)`,
    );
  }
  return value;
}

/** Today's date as `YYYY-MM-DD` in `tz` (or host local). */
export function isoDateNow(tz?: string | null): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

/** Current time as `HH:MM` (24h) in `tz` (or host local). */
export function isoTimeNow(tz?: string | null): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz ?? undefined,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("hour")}:${get("minute")}`;
}

/** Compose an ISO Z timestamp from a `YYYY-MM-DD` + `HH:MM` pair. */
export function isoTimestampZ(date: string, time: string, tz?: string | null): string {
  validateIsoDate(date);
  validateIsoTime(time);
  // Treat the supplied wall-clock as UTC unless a timezone is provided.
  // We don't try to round-trip arbitrary IANA zones offline — agents that
  // need precise local timestamps pass the date/time explicitly and we
  // serialize them as-is in the Z form. The optional `tz` argument is a
  // hook for the CLI to record the configured zone in metadata, not to
  // shift the wall-clock.
  void tz;
  return `${date}T${time}:00Z`;
}

