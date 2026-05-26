/**
 * Filesystem paths and date utilities for the Pay Memory layout.
 *
 * The layout sits inside `<vault>/Brain/payments/`:
 *   - policies/spending.md
 *   - YYYY-MM-DD/<slug>.md       (receipts go directly under the root)
 *   - assets/<slug>.md
 *   - drafts/<slug>.md           (written by other tools)
 *   - reports/<slug>.md
 *   - _pending/<id>.md           (approval workflow)
 *
 * Date subdirectories use the hyphenated `YYYY-MM-DD` form (ISO 8601
 * calendar date).
 */

import { join, posix } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/paths.ts";

export {
  ensureInsideVault,
  vaultRelative,
} from "../path-safety.ts";

// ----- Canonical Pay Memory path constants ----------------------------------
//
// Every path the Pay Memory layer writes to is named here. Other
// modules (receipt, report, approval, policy, MCP tool descriptions,
// CLI help text) import these instead of repeating the literal so a
// future rename cascades from one edit.

/** Vault-relative root of Pay Memory under the Brain layer. */
export const PAY_MEMORY_ROOT_REL = posix.join(BRAIN_ROOT_REL, "payments");

/** Vault-relative Pay Memory subdirectory names. */
export const PAY_MEMORY_POLICIES_REL = posix.join(PAY_MEMORY_ROOT_REL, "policies");
export const PAY_MEMORY_ASSETS_REL = posix.join(PAY_MEMORY_ROOT_REL, "assets");
export const PAY_MEMORY_DRAFTS_REL = posix.join(PAY_MEMORY_ROOT_REL, "drafts");
export const PAY_MEMORY_REPORTS_REL = posix.join(PAY_MEMORY_ROOT_REL, "reports");
export const PAY_MEMORY_PENDING_REL = posix.join(PAY_MEMORY_ROOT_REL, "_pending");

/** Spending-policy file paths (vault-relative). */
export const PAY_MEMORY_SPENDING_MD_REL = posix.join(
  PAY_MEMORY_POLICIES_REL,
  "spending.md",
);
export const PAY_MEMORY_SPENDING_JSON_REL = posix.join(
  PAY_MEMORY_POLICIES_REL,
  "spending.json",
);

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^(\d{2}):(\d{2})$/;

export interface PayMemoryDirs {
  readonly policies: string;
  readonly payments: string;
  readonly assets: string;
  readonly drafts: string;
  readonly reports: string;
  readonly pending: string;
}

export function payMemoryDirs(vault: string): PayMemoryDirs {
  return {
    policies: join(vault, PAY_MEMORY_POLICIES_REL),
    payments: join(vault, PAY_MEMORY_ROOT_REL),
    assets: join(vault, PAY_MEMORY_ASSETS_REL),
    drafts: join(vault, PAY_MEMORY_DRAFTS_REL),
    reports: join(vault, PAY_MEMORY_REPORTS_REL),
    pending: join(vault, PAY_MEMORY_PENDING_REL),
  };
}

export function policyPath(vault: string): string {
  return join(vault, PAY_MEMORY_SPENDING_MD_REL);
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

// Windows reserves a small set of base filenames (case-insensitive) and
// rejects any path whose final component matches them — even with an
// extension. We reject these here so the same vault can be cloned to a
// Windows host without surprise EINVALs at write time.
const WINDOWS_RESERVED_BASENAME_RE =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Reject slugs that could escape the intended Pay Memory subdirectory or
 * (under `..` traversal) silently land elsewhere in the vault, plus a few
 * Windows-specific filename hazards so the artefact is portable.
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
  if (/[. ]$/.test(trimmed)) {
    throw new Error(
      `slug must not end with '.' or whitespace (Windows-incompatible): ${slug}`,
    );
  }
  if (WINDOWS_RESERVED_BASENAME_RE.test(trimmed)) {
    throw new Error(`slug uses a Windows-reserved filename: ${slug}`);
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

/**
 * Compose an ISO Z timestamp from a `YYYY-MM-DD` + `HH:MM` pair, treating
 * the supplied wall-clock as occurring in `tz` (or UTC if `tz` is null).
 *
 * Without `tz`, the wall-clock is taken to already be UTC and we emit the
 * `Z` form directly. With a `tz`, we compute that zone's offset for the
 * given instant and shift the wall-clock to a true UTC moment — so a
 * 09:00 Belgrade event becomes the correct `07:00Z` (or `06:00Z` outside
 * DST) instead of falsely labelling 09:00 itself as `Z`.
 *
 * The offset trick uses `Intl.DateTimeFormat` to format the same instant
 * twice (in UTC and in `tz`) and reads the difference. It's accurate to
 * the minute for every IANA zone except during the one-hour DST overlap,
 * where the choice is arbitrary — acceptable for a Markdown audit trail.
 */
export function isoTimestampZ(date: string, time: string, tz?: string | null): string {
  validateIsoDate(date);
  validateIsoTime(time);
  if (!tz) {
    return `${date}T${time}:00Z`;
  }
  const utcMillis = utcMillisForLocalWallClock(date, time, tz);
  return new Date(utcMillis).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Given a wall-clock `YYYY-MM-DD HH:MM` interpreted as occurring in IANA
 * `tz`, return the corresponding UTC milliseconds-since-epoch.
 *
 * Strategy: take the naive UTC instant for the literal wall-clock, then
 * subtract the offset between UTC and `tz` at that instant. That gives
 * the real UTC moment whose local-tz formatting matches the input.
 */
function utcMillisForLocalWallClock(date: string, time: string, tz: string): number {
  const naiveUtc = Date.parse(`${date}T${time}:00Z`);
  const offsetMinutes = tzOffsetMinutes(naiveUtc, tz);
  return naiveUtc - offsetMinutes * 60_000;
}

function tzOffsetMinutes(instantMs: number, tz: string): number {
  // Format the same instant in both `tz` and UTC; the spread between the
  // two formatted wall-clocks IS the zone's offset at that instant.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const localUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((localUtcMs - instantMs) / 60_000);
}

