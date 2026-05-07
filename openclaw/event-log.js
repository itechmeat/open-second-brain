/**
 * Pure JavaScript event log operations for Open Second Brain.
 *
 * All filesystem operations use `node:fs/promises` and `node:path`.
 * No native process module, no subprocess calls — passes the OpenClaw security scanner.
 *
 * Logic mirrors the Python implementation in `src/open_second_brain/event_log.py`.
 *
 * Daily note format:
 *   File: vault/Daily/YYYY.MM.DD.md
 *   Sections separated by ---
 *   Events under ## Raw events (lowercase 'events' to match Python)
 *   Entries: - HH:MM — @agent — message
 *   Chronologically sorted within the section
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ── Constants ──────────────────────────────────────────────────────────────

const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|token|secret|password|credential)(\s*[:=]\s*)([^\s]+)/gi;

const EVENT_RE = /^- (\d{2}:\d{2}) — @/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Redact secret-like values from text.
 */
function redactText(text) {
  return text.replace(SECRET_ASSIGNMENT_RE, "$1$2[REDACTED]");
}

/**
 * Get current date in YYYY.MM.DD format.
 */
function currentDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

/**
 * Get current time in HH:MM 24-hour format.
 */
function currentTime() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Validate a time string in HH:MM 24-hour format.
 * Returns the validated time string or throws.
 */
function validateEventTime(value) {
  const match = TIME_RE.exec(value);
  if (!match) {
    throw new Error("event time must use HH:MM 24-hour format");
  }
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour > 23 || minute > 59) {
    throw new Error("event time must use HH:MM 24-hour format");
  }
  return value;
}

/**
 * Build a new empty daily note.
 */
function newDailyNote(date) {
  return `---\nformatted: false\n---\n\n# ${date}\n\n## Raw events\n\n`;
}

/**
 * Insert an event entry into the daily note content, maintaining chronological order.
 * Uses the "## Raw events" heading (lowercase, matching Python).
 */
function insertEventEntry(content, entry) {
  const marker = "## Raw events";
  const idx = content.indexOf(marker);
  if (idx === -1) {
    // Shouldn't happen since we ensure it exists, but handle gracefully
    return content + "\n\n" + marker + "\n\n" + entry + "\n";
  }

  const before = content.slice(0, idx);
  const after = content.slice(idx + marker.length);

  // Strip leading newlines from after section
  const afterStripped = after.replace(/^\n+/, "");
  const lines = afterStripped.split("\n").filter((line) => line.trim());

  // Extract time from entry: "- HH:MM — @..."
  const entryTime = entry.slice(2, 7);

  let inserted = false;
  const output = [];
  for (const line of lines) {
    const match = EVENT_RE.exec(line);
    if (!inserted && match && match[1] > entryTime) {
      output.push(entry);
      inserted = true;
    }
    output.push(line);
  }
  if (!inserted) {
    output.push(entry);
  }

  let rawEvents = output.join("\n");
  if (rawEvents) {
    rawEvents += "\n";
  }

  return before + marker + "\n\n" + rawEvents;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Append an event to the daily event log.
 *
 * @param {string} vaultPath - Absolute path to the vault directory.
 * @param {string} agent - Agent name (e.g., "hermes-agent").
 * @param {string} message - Event message text.
 * @param {string|null} date - Optional date in YYYY.MM.DD format.
 * @param {string|null} time - Optional time in HH:MM format.
 * @returns {Promise<{path: string, relativePath: string, agent: string, date: string|null, time: string|null}>}
 */
export async function appendEvent(vaultPath, agent, message, date = null, time = null) {
  const eventDate = date || currentDate();
  const eventTime = validateEventTime(time || currentTime());

  const dailyDir = join(vaultPath, "Daily");
  const filePath = join(dailyDir, `${eventDate}.md`);

  await mkdir(dailyDir, { recursive: true });

  // Build the event line (replace newlines in message with spaces)
  const cleanMessage = redactText(message).replace(/\n/g, " ");
  const entry = `- ${eventTime} — @${agent} — ${cleanMessage}`;

  let content;
  if (existsSync(filePath)) {
    content = await readFile(filePath, "utf8");
  } else {
    content = newDailyNote(eventDate);
  }

  // Ensure the Raw events section exists
  if (!content.includes("## Raw events")) {
    content = content.trimEnd() + "\n\n## Raw events\n\n";
  }

  const updated = insertEventEntry(content, entry);

  // Atomic write using a temp file in the same directory
  const tmpPath = join(dailyDir, `.${eventDate}.tmp-${randomUUID()}`);
  await writeFile(tmpPath, updated, "utf8");

  // Rename is atomic on same filesystem
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, filePath);

  const relativePath = `Daily${require("node:path").sep}${eventDate}.md`;
  return {
    path: filePath,
    relativePath,
    agent,
    date: date || null,
    time: time || null,
  };
}
