/**
 * Daily event log: append-only Markdown notes with chronological order and
 * cross-process safety.
 *
 * Mirrors `src/open_second_brain/event_log.py`. The locking strategy uses
 * `proper-lockfile` because Bun/Node lack a portable `fcntl.flock` equivalent;
 * `proper-lockfile` is the de-facto standard (lockfile + retry with stale
 * detection) and survives the same multi-process append test.
 */

import lockfile from "proper-lockfile";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "./fs-atomic.ts";

const SECRET_ASSIGNMENT_RE = /\b(api[_-]?key|token|secret|password|credential)(\s*[:=]\s*)\S+/gi;
const EVENT_RE = /^- (\d{2}:\d{2}) — @/;
const DATE_RE = /^(\d{4})\.(\d{2})\.(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Match PEM block headers for private-key-like types. */
const PEM_BEGIN_RE = /-----BEGIN\s+(?:RSA\s+)?(?:EC\s+)?(?:DSA\s+)?(?:OPENSSH\s+)?(?:ENCRYPTED\s+)?(?:PGP\s+)?PRIVATE KEY-----/;
const PEM_END_RE = /-----END\s+(?:RSA\s+)?(?:EC\s+)?(?:DSA\s+)?(?:OPENSSH\s+)?(?:ENCRYPTED\s+)?(?:PGP\s+)?PRIVATE KEY-----/;

/**
 * Conservative JWT-shaped token heuristic: three base64url segments
 * (alphanumeric, `-`, `_`) separated by dots, total length ≥ 32 chars.
 * Excludes common false positives like version numbers (`1.2.3`) by
 * requiring each segment to be at least 4 characters.
 */
const JWT_RE = /\b[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}\b/g;

/** Redact PEM private-key blocks with a `<REDACTED>` marker. */
function redactPemBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside) {
      if (PEM_BEGIN_RE.test(line)) {
        inside = true;
        out.push("[REDACTED PRIVATE KEY]");
      } else {
        out.push(line);
      }
    } else {
      if (PEM_END_RE.test(line)) {
        inside = false;
        // The END line itself is consumed by the redaction marker.
      }
      // All interior lines are silently dropped.
    }
  }
  return out.join("\n");
}

/** Mask standalone JWT-shaped tokens to last 4 chars. */
function redactJwtTokens(text: string): string {
  return text.replace(JWT_RE, (match) => {
    const tail = match.slice(-4);
    return `***REDACTED_JWT_${tail}`;
  });
}

/** Replace secret-like value assignments with `[REDACTED]`. */
function redactSecretAssignments(text: string): string {
  return text.replace(SECRET_ASSIGNMENT_RE, (_match, field, sep) => `${field}${sep}[REDACTED]`);
}

/**
 * Multi-pass redaction: PEM blocks → JWT tokens → secret assignments.
 * PEM runs line-by-line first so multi-line blocks are consumed before
 * the regex-based passes see the interior base64 data.
 */
export function redactText(text: string): string {
  return redactSecretAssignments(redactJwtTokens(redactPemBlocks(text)));
}

/**
 * Current date as `YYYY.MM.DD` in `tz` (or host local).
 *
 * When `tz` is supplied, the date is computed in that zone — relevant around
 * midnight when host UTC and user local fall on different days.
 */
export function currentDate(tz?: string | null): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD; replace separators to get YYYY.MM.DD.
  return fmt.format(new Date()).replace(/-/g, ".");
}

/** Current time as `HH:MM` (24h) in `tz` (or host local). */
export function currentTime(tz?: string | null): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz ?? undefined,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("hour")}:${get("minute")}`;
}

/** Path of the daily note file for `date` inside `vaultDir`. */
export function dailyNotePath(vaultDir: string, date: string): string {
  return join(vaultDir, "Daily", `${validateEventDate(date)}.md`);
}

/** Empty-daily-note template. */
export function newDailyNote(date: string): string {
  return `---\nformatted: false\n---\n\n# ${date}\n\n## Raw events\n\n`;
}

/** Validate a `HH:MM` 24-hour time string. Throws on invalid. */
export function validateEventTime(value: string): string {
  const m = TIME_RE.exec(value);
  if (!m) {
    throw new Error("event time must use HH:MM 24-hour format");
  }
  const hour = parseInt(m[1]!, 10);
  const minute = parseInt(m[2]!, 10);
  if (hour > 23 || minute > 59) {
    throw new Error("event time must use HH:MM 24-hour format");
  }
  return value;
}

/** Validate a `YYYY.MM.DD` date string. Throws on invalid. */
export function validateEventDate(value: string): string {
  const m = DATE_RE.exec(value);
  if (!m) {
    throw new Error("event date must use YYYY.MM.DD format");
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
    throw new Error("event date must use YYYY.MM.DD format");
  }
  return value;
}

/**
 * Insert an event entry into the `## Raw events` section, preserving
 * chronological order. Pure function — no I/O, easy to unit-test.
 */
export function insertEventEntry(content: string, entry: string): string {
  const marker = "## Raw events";
  const idx = content.indexOf(marker);
  if (idx === -1) {
    return content.trimEnd() + "\n\n" + marker + "\n\n" + entry + "\n";
  }
  const before = content.slice(0, idx);
  let after = content.slice(idx + marker.length).replace(/^\n+/, "");
  const lines = after.split("\n").filter((line) => line.trim());

  // Entry shape: "- HH:MM — @..."
  const entryTime = entry.slice(2, 7);
  let inserted = false;
  const output: string[] = [];
  for (const line of lines) {
    const m = EVENT_RE.exec(line);
    if (!inserted && m && m[1]! > entryTime) {
      output.push(entry);
      inserted = true;
    }
    output.push(line);
  }
  if (!inserted) output.push(entry);

  let raw = output.join("\n");
  if (raw) raw += "\n";
  return before + marker + "\n\n" + raw;
}

export interface AppendEventOptions {
  readonly date?: string | null;
  readonly time?: string | null;
  readonly tz?: string | null;
}

/**
 * Append a single event to today's (or a specified) Daily note.
 *
 * Behavior parity with the Python implementation:
 *   - creates `<vault>/Daily/<date>.md` if missing, with a `## Raw events` section;
 *   - inserts the entry chronologically;
 *   - cross-process safe via `proper-lockfile` on the daily file path;
 *   - atomic write (temp + rename + fsync of file and parent dir);
 *   - redacts secret-like assignments in `message` before writing;
 *   - replaces newlines in message with spaces (one entry = one line).
 *
 * Returns the absolute path of the daily note that was written.
 */
export async function appendEvent(
  vaultDir: string,
  agent: string,
  message: string,
  opts: AppendEventOptions = {},
): Promise<string> {
  const tz = opts.tz ?? null;
  const eventDate = validateEventDate(opts.date ?? currentDate(tz));
  const eventTime = validateEventTime(opts.time ?? currentTime(tz));
  const path = dailyNotePath(vaultDir, eventDate);

  const cleanMessage = redactText(message).replace(/\r?\n/g, " ");
  const entry = `- ${eventTime} — @${agent} — ${cleanMessage}`;

  // proper-lockfile requires the target to exist for `lock(path)`. We lock the
  // parent directory (`Daily/`) instead, which is created up-front and shared
  // across all daily files. Locking the directory is the same scope used by
  // the Python fcntl.flock on a sibling `.{name}.lock` file.
  const dailyDir = join(vaultDir, "Daily");
  mkdirSync(dailyDir, { recursive: true });

  const release = await lockfile.lock(dailyDir, {
    retries: { retries: 30, factor: 1.2, minTimeout: 30, maxTimeout: 500 },
    stale: 10_000,
    realpath: false,
  });

  try {
    let content: string;
    if (existsSync(path)) {
      content = readFileSync(path, "utf8");
    } else {
      content = newDailyNote(eventDate);
    }
    if (!content.includes("## Raw events")) {
      content = content.trimEnd() + "\n\n## Raw events\n\n";
    }
    const updated = insertEventEntry(content, entry);
    atomicWriteFileSync(path, updated);
  } finally {
    await release();
  }

  return path;
}
