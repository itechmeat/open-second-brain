/**
 * Brain log (`Brain/log/<YYYY-MM-DD>.md`) parser and appender.
 *
 * The log is the audit trail of every state-changing Brain operation.
 * One Markdown file per UTC day; events appear as level-2 headings
 * formatted as `## <HH:MM:SS>Z — <event-kind>` followed by a bullet
 * list of `- <key>: <value>` lines. Lists are encoded as repeated
 * `- key:` entries with sub-bullets (the simple parser accepts both
 * `- key: value` and the indented sub-bullet form for arrays).
 *
 * Two operations:
 *
 *   - {@link parseLogDay} reads one day's file and returns an array of
 *     {@link BrainLogEntry}. Malformed entries (broken header, invalid
 *     bullet shape) are skipped and surfaced via the `warnings` array
 *     so the dream loop and digest never blow up on a partially-edited
 *     log. Returns an empty array when the file does not exist.
 *
 *   - {@link appendLogEvent} writes a new event to today's log. If the
 *     file is absent, it is created with a canonical frontmatter
 *     header (`kind: brain-log`, `date`, `tags`) and the title line.
 *     Subsequent appends preserve previous bytes verbatim — the
 *     log is append-only. Atomicity is achieved by reading the
 *     existing contents, appending the new block, and writing the
 *     result back through `fs-atomic` in one shot.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";

import lockfile from "proper-lockfile";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { brainDirs, logPath, logShardJsonlPath, logShardPath, validateIsoDate } from "./paths.ts";
import { isValidDeviceId, resolveDeviceId } from "../config.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_LOG_EVENT_KIND_SET, type BrainLogEventKind } from "./types.ts";

// ----- Public types ---------------------------------------------------------

/** Parsed bullet payload of a single log entry. */
export type BrainLogEntryPayload = Readonly<Record<string, string | ReadonlyArray<string>>>;

/**
 * A parsed log entry. `timestamp` is the full ISO-8601 UTC moment
 * reconstructed from the file's `date` and the heading's `HH:MM:SS`
 * stamp. `body` keeps the bullet payload verbatim (string for single
 * values, string[] for repeated keys).
 */
export interface BrainLogEntry {
  readonly timestamp: string;
  readonly eventType: BrainLogEventKind;
  readonly agent?: string;
  readonly body: BrainLogEntryPayload;
}

/** Warning surfaced by {@link parseLogDay} for a malformed sub-block. */
export interface BrainLogParseWarning {
  readonly path: string;
  readonly lineNumber: number;
  readonly message: string;
}

export interface ParseLogDayResult {
  readonly entries: ReadonlyArray<BrainLogEntry>;
  readonly warnings: ReadonlyArray<BrainLogParseWarning>;
}

export interface AppendLogEventResult {
  readonly logPath: string;
}

// ----- Constants ------------------------------------------------------------

// `## HH:MM:SSZ — <kind>` — both the em dash (—) and the hyphen are
// accepted to tolerate hand-edits. The mandatory `Z` after the time
// reflects the design doc's "UTC time" formatting (§5.5 example).
const HEADER_RE = /^##\s+(\d{2}):(\d{2}):(\d{2})Z\s+[—-]\s+([a-z][a-z0-9-]*)\s*$/;

// Bullet keys are limited to ASCII identifiers (with `_`) plus
// hyphens. We accept any text after the colon, including wikilinks,
// quoted strings, and multi-word values — the parser does not try to
// interpret them, only to record the key/value split.
const BULLET_RE = /^-\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

// Sub-bullets nest underneath a parent bullet that ends with a bare
// colon (no value). The leading whitespace varies in real-world
// edits; we accept 2-or-more spaces or one or more tabs.
const SUB_BULLET_RE = /^(?:\s{2,}|\t+)-\s+(.+)$/;

// ----- Public API -----------------------------------------------------------

/**
 * Parse `Brain/log/<date>.md` if present. Returns an empty array when
 * the file does not exist — there is no Brain log for that day yet.
 *
 * `parseLogDay` is tolerant of garbage: malformed headers, unknown
 * event kinds, or stray bullets get reported as warnings and the rest
 * of the file is still returned. This keeps the dream loop alive even
 * when a manual edit corrupts a single block.
 */
export function parseLogDay(vault: string, date: string): ParseLogDayResult {
  const validDate = validateIsoDate(date);
  return parseLogDayFile(vault, validDate, logPath(vault, validDate));
}

/**
 * Parse one specific log markdown file for `date`. The per-device
 * shard layout (Memory Integrity Suite) means a day can have several
 * markdown files (`<date>.md`, `<date>.<deviceId>.md`); the shard
 * readers in log-jsonl.ts call this once per file and merge.
 */
export function parseLogDayFile(vault: string, date: string, path: string): ParseLogDayResult {
  const validDate = validateIsoDate(date);
  if (!existsSync(path)) {
    return { entries: [], warnings: [] };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { entries: [], warnings: [] };
  }

  const entries: BrainLogEntry[] = [];
  const warnings: BrainLogParseWarning[] = [];

  // Strip the YAML frontmatter and the top-level title to expose the
  // event blocks. We do this with a manual scan rather than the
  // frontmatter parser because we need the raw line numbers for the
  // warning trail.
  const lines = text.split(/\r?\n/);
  let cursor = 0;
  if (lines[0]?.trimEnd() === "---") {
    cursor = 1;
    while (cursor < lines.length && lines[cursor]?.trimEnd() !== "---") {
      cursor++;
    }
    if (cursor < lines.length) cursor++; // skip closing '---'
  }

  // Each event block starts at a `## ...` line and ends at the next
  // `## ...` or EOF. We collect them in encounter order so the
  // caller's "stable order" guarantee is honoured.
  while (cursor < lines.length) {
    const line = lines[cursor]!;
    if (!line.startsWith("## ")) {
      cursor++;
      continue;
    }
    const headerLineNumber = cursor + 1;
    const header = HEADER_RE.exec(line);
    if (!header) {
      warnings.push({
        path,
        lineNumber: headerLineNumber,
        message: `malformed event header: ${line}`,
      });
      cursor++;
      continue;
    }
    const hh = header[1]!;
    const mm = header[2]!;
    const ss = header[3]!;
    const kindStr = header[4]!;
    if (!BRAIN_LOG_EVENT_KIND_SET.has(kindStr)) {
      warnings.push({
        path,
        lineNumber: headerLineNumber,
        message: `unknown event kind: ${kindStr}`,
      });
      cursor++;
      // Skip the malformed block's body so we don't try to parse its
      // bullets as a top-level event.
      while (cursor < lines.length && !lines[cursor]!.startsWith("## ")) {
        cursor++;
      }
      continue;
    }

    // Read bullets until the next event header or EOF.
    cursor++;
    const blockStart = cursor;
    while (cursor < lines.length && !lines[cursor]!.startsWith("## ")) {
      cursor++;
    }
    const blockEnd = cursor;

    const { payload, blockWarnings } = parseBulletBlock(
      lines.slice(blockStart, blockEnd),
      blockStart + 1,
      path,
    );
    for (const w of blockWarnings) warnings.push(w);

    entries.push({
      timestamp: `${validDate}T${hh}:${mm}:${ss}Z`,
      eventType: kindStr as BrainLogEventKind,
      agent: typeof payload.agent === "string" ? payload.agent : undefined,
      body: Object.freeze(payload),
    });
  }

  return { entries, warnings };
}

/**
 * Append a new event to the log for the day of `event.timestamp`. If
 * the log file does not yet exist, it is created with the canonical
 * frontmatter + title header; otherwise the existing file is read,
 * concatenated with the new block, and written back atomically. We
 * never edit prior blocks — append-only is the contract.
 *
 * Two writes happening at the same UTC second receive the same
 * `<HH:MM:SS>` header; the on-disk order is the order of calls to
 * this function. That's the stability guarantee the test suite asks
 * for.
 */
/**
 * Acquire the per-log-day directory lock with a bounded retry loop.
 *
 * `proper-lockfile`'s sync API refuses the `retries` option (it
 * cannot block the event loop on a callback), so the retry loop is
 * spelled out here: on `ELOCKED` the call sleeps for `SLEEP_MS` and
 * tries again, up to `MAX_ATTEMPTS`. Any non-`ELOCKED` error is
 * rethrown immediately (permission, fs corruption, …).
 *
 * Total worst-case wait: `MAX_ATTEMPTS * SLEEP_MS` ≈ 500 ms — short
 * enough to feel synchronous to a coding agent, long enough to ride
 * out a sibling `appendLogEvent` call that landed within the same
 * millisecond.
 */
function acquireLogLock(logDir: string): () => void {
  const MAX_ATTEMPTS = 10;
  const SLEEP_MS = 50;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return lockfile.lockSync(logDir, { stale: 10_000, realpath: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ELOCKED") throw err;
      lastErr = err;
      if (attempt < MAX_ATTEMPTS - 1) Bun.sleepSync(SLEEP_MS);
    }
  }
  throw lastErr;
}

export interface AppendLogEventOptions {
  /**
   * Per-device shard id (Memory Integrity Suite). Defaults to
   * `resolveDeviceId()` from the device-local config; the empty string
   * forces the legacy un-sharded `<date>.jsonl` / `<date>.md` pair.
   * Resolution failure (read-only config home, missing HOME) falls back
   * to the legacy pair too - an append must never fail on identity.
   */
  readonly deviceId?: string;
}

export function appendLogEvent(
  vault: string,
  event: BrainLogEntry,
  opts: AppendLogEventOptions = {},
): AppendLogEventResult {
  if (!BRAIN_LOG_EVENT_KIND_SET.has(event.eventType)) {
    throw new Error(
      `appendLogEvent: unknown event kind '${event.eventType}' — must be one of ${Object.values(
        BRAIN_LOG_EVENT_KIND,
      ).join(", ")}`,
    );
  }
  let deviceId: string;
  if (opts.deviceId !== undefined) {
    if (opts.deviceId !== "" && !isValidDeviceId(opts.deviceId)) {
      throw new Error(
        `appendLogEvent: invalid deviceId ${JSON.stringify(opts.deviceId)} - ` +
          "expected a lowercase slug matching the device_id config shape",
      );
    }
    deviceId = opts.deviceId;
  } else {
    try {
      deviceId = resolveDeviceId();
    } catch {
      deviceId = ""; // fail-soft: legacy un-sharded pair
    }
  }
  // Parse the timestamp once to extract date + HHMMSS deterministically.
  // We deliberately do not accept Date objects: the caller controls the
  // canonical representation so two calls with identical input produce
  // byte-identical output (idempotency requirement).
  const ts = parseIsoUtc(event.timestamp);
  const path = logShardPath(vault, ts.date, deviceId);
  const jsonlPath = logShardJsonlPath(vault, ts.date, deviceId);
  const logDir = brainDirs(vault).log;
  const topLevelAgent = (event as { agent?: unknown }).agent;
  const eventBody =
    typeof topLevelAgent === "string" && typeof event.body["agent"] !== "string"
      ? Object.freeze({ ...event.body, agent: topLevelAgent })
      : event.body;
  const diskEvent: BrainLogEntry = eventBody === event.body ? event : { ...event, body: eventBody };

  // §23 (v0.10.8): each event lands in both `<date>.jsonl` (machine
  // surface, primary for `readLogDay`) and `<date>.md` (human-facing
  // Obsidian view). JSONL is written first so a partial failure
  // (e.g. ENOSPC between the two writes) leaves the machine-readable
  // source authoritative — discipline-report and future tooling keep
  // returning the correct counts; only the human Obsidian view lags
  // until the next successful append rewrites the markdown.
  //
  // The pair shares one directory-level lock so two concurrent
  // appenders cannot interleave each other's halves.
  mkdirSync(logDir, { recursive: true });
  const release = acquireLogLock(logDir);

  try {
    // ---- JSONL sidecar (machine surface, primary) ---------------------
    // One row per event. The row is a deterministic projection of the
    // markdown body so the markdown and JSONL representations describe
    // the same event byte-for-byte after JSON.parse.
    const existingJsonl = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : "";
    const line = renderJsonlLine(diskEvent);
    const nextJsonl =
      existingJsonl === "" ? `${line}\n` : `${existingJsonl.replace(/\s+$/, "")}\n${line}\n`;
    atomicWriteFileSync(jsonlPath, nextJsonl);

    // ---- Markdown (human surface) -------------------------------------
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const block = renderEventBlock(diskEvent, ts.hms);

    let next: string;
    if (existing === "") {
      next = renderFileHeader(ts.date) + "\n" + block;
    } else {
      // Guarantee exactly one blank line between blocks; previous file
      // may or may not end with a trailing newline.
      const trimmed = existing.replace(/\s+$/, "");
      next = `${trimmed}\n\n${block}`;
    }
    // Always finish with a single trailing newline — standard Markdown
    // hygiene, and matches what `formatFrontmatter` emits elsewhere.
    if (!next.endsWith("\n")) next += "\n";

    atomicWriteFileSync(path, next);
  } finally {
    release();
  }

  return { logPath: path };
}

// ----- Renderers ------------------------------------------------------------

function renderFileHeader(date: string): string {
  // Frontmatter is hand-rendered (not via `formatFrontmatter`) because
  // the tags array must be a stable, comma-separated inline list, and
  // we need byte-deterministic output for the test suite.
  const lines: string[] = [
    "---",
    "kind: brain-log",
    `date: ${date}`,
    "tags: [brain, brain/log]",
    "---",
    "",
    `# Brain log — ${date}`,
  ];
  return lines.join("\n") + "\n";
}

function renderEventBlock(event: BrainLogEntry, hms: string): string {
  const lines: string[] = [`## ${hms}Z — ${event.eventType}`];
  // Stable iteration order: keys in the order they appear in the
  // payload object. The caller is responsible for the order they care
  // about; we don't sort because some events benefit from a logical
  // grouping (e.g. `run_id` first).
  for (const [key, value] of Object.entries(event.body)) {
    if (Array.isArray(value)) {
      // Repeated keys are encoded as a parent bullet with the bare key
      // followed by indented sub-bullets — matches the design-doc
      // example for `dream.new_unconfirmed`.
      lines.push(`- ${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`- ${key}: ${value}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the JSONL projection of an event (§23, v0.10.8). The row
 * shape is `{ ts, kind, payload }` where `payload` is a one-to-one map
 * of the markdown body bullets. Array bullets become JSON arrays;
 * scalar bullets become JSON strings. The function never sorts keys,
 * so byte-identical inputs produce byte-identical rows.
 */
function renderJsonlLine(event: BrainLogEntry): string {
  const payload: Record<string, string | ReadonlyArray<string>> = {};
  for (const [key, value] of Object.entries(event.body)) {
    payload[key] = value;
  }
  return JSON.stringify({
    ts: event.timestamp,
    kind: event.eventType,
    payload,
  });
}

// ----- Bullet block parser --------------------------------------------------

interface ParseBulletResult {
  readonly payload: Record<string, string | ReadonlyArray<string>>;
  readonly blockWarnings: ReadonlyArray<BrainLogParseWarning>;
}

function parseBulletBlock(
  lines: ReadonlyArray<string>,
  startLineNumber: number,
  path: string,
): ParseBulletResult {
  const payload: Record<string, string | ReadonlyArray<string>> = {};
  const blockWarnings: BrainLogParseWarning[] = [];

  // We walk the block linearly. Top-level bullets either carry their
  // value inline (`- key: value`) or open a sub-bullet list (`- key:`
  // followed by `  - <item>` lines). We close the current sub-list as
  // soon as we hit either another top-level bullet or a blank line.
  let cursor = 0;
  let currentListKey: string | null = null;
  let currentList: string[] | null = null;

  const flushList = (): void => {
    if (currentListKey !== null && currentList !== null) {
      payload[currentListKey] = currentList;
    }
    currentListKey = null;
    currentList = null;
  };

  while (cursor < lines.length) {
    const raw = lines[cursor]!;
    const lineNumber = startLineNumber + cursor;
    const trimmed = raw.trim();
    if (trimmed === "") {
      flushList();
      cursor++;
      continue;
    }
    const sub = SUB_BULLET_RE.exec(raw);
    if (sub && currentList !== null) {
      currentList.push(sub[1]!.trim());
      cursor++;
      continue;
    }
    const bullet = BULLET_RE.exec(raw);
    if (!bullet) {
      blockWarnings.push({
        path,
        lineNumber,
        message: `malformed bullet: ${raw}`,
      });
      flushList();
      cursor++;
      continue;
    }
    flushList();
    const key = bullet[1]!;
    const value = bullet[2]!;
    if (value === "") {
      currentListKey = key;
      currentList = [];
    } else {
      payload[key] = value;
    }
    cursor++;
  }
  flushList();
  return { payload, blockWarnings };
}

// ----- Time utilities ------------------------------------------------------

interface IsoUtcParts {
  readonly date: string;
  readonly hms: string;
}

/**
 * Parse an ISO-8601 UTC timestamp into its date and `HH:MM:SS` parts.
 * Accepts both `2026-05-14T10:42:00Z` and `2026-05-14T10:42:00.123Z`
 * forms; sub-second precision is truncated to seconds because the log
 * heading shape is `HH:MM:SS` only.
 */
function parseIsoUtc(timestamp: string): IsoUtcParts {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(timestamp);
  if (!m) {
    throw new Error(
      `appendLogEvent: timestamp must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ); got ${JSON.stringify(timestamp)}`,
    );
  }
  return { date: m[1]!, hms: `${m[2]!}:${m[3]!}:${m[4]!}` };
}
