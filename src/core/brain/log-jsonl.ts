/**
 * Brain log reader (§23, v0.10.8; per-device shards in the Memory
 * Integrity Suite). A day's events live in one or more files:
 *
 *   - `<date>.jsonl` / `<date>.md`                - legacy single pair,
 *     treated as the shard with the empty shard id;
 *   - `<date>.<deviceId>.jsonl` / `.md`           - one pair per device.
 *
 * `readLogDay` merges every shard of a day sorted by
 * (timestamp, shardId, line) - deterministic across devices regardless
 * of Syncthing arrival order. Per shard the JSONL sidecar is preferred
 * and the markdown is the fallback, so pre-v0.10.8 markdown history
 * keeps reading even when new shards exist for the same date.
 *
 * Every machine consumer of `Brain/log/` discovers dates through
 * `listLogDates` and reads through `readLogDay`, so the shard layout
 * lives in exactly one module. Malformed JSONL lines surface as
 * `warnings` instead of aborting the read, matching `parseLogDay`'s
 * tolerance contract.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { brainDirs, validateIsoDate } from "./paths.ts";
import { parseLogDayFile, type BrainLogEntry, type BrainLogParseWarning } from "./log.ts";
import { BRAIN_LOG_EVENT_KIND_SET, type BrainLogEventKind } from "./types.ts";

export interface ReadLogDayResult {
  readonly entries: ReadonlyArray<BrainLogEntry>;
  readonly source: "jsonl" | "markdown-fallback";
  readonly warnings: ReadonlyArray<BrainLogParseWarning>;
}

// Canonical ISO-8601 UTC timestamp shape emitted by `renderJsonlLine`
// in `log.ts`. Accept the same shape `parseIsoUtc` recognises so the
// JSONL reader cannot leak a value that the markdown side would
// reject. Sub-second precision is allowed because `JSON.stringify`
// of a `Date` produces it; `parseIsoUtc` strips it back to seconds.
//
// Sibling regex: `ISO_8601_RE` in `src/cli/coerce.ts`. That one is
// looser (accepts `±HH:MM` offset, caps millisecond precision at 3
// digits) because it has to admit whatever a human typed on the
// CLI; this one is strict because it only ever sees values the
// writer side just produced in canonical UTC. The two intentionally
// do not share a constant — drift in either direction would silently
// break the contract of the other surface.
const ISO_UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// One log file name: `<date>.jsonl`, `<date>.md`, or the sharded
// `<date>.<deviceId>.jsonl` / `.md`. Device ids are lowercase slugs
// (see `resolveDeviceId`); Syncthing conflict copies and anything else
// that does not match are NOT log shards.
const LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.([a-z0-9-]{1,32}))?\.(jsonl|md)$/;

interface LogShardFile {
  readonly date: string;
  /** Empty string for the legacy un-sharded pair. */
  readonly shardId: string;
  readonly ext: "jsonl" | "md";
  readonly path: string;
  readonly name: string;
}

/** Every recognised log file under `Brain/log/`, sorted by name. */
function listLogShardFiles(vault: string): LogShardFile[] {
  const dir = brainDirs(vault).log;
  if (!existsSync(dir)) return [];
  const out: LogShardFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    const m = LOG_FILE_RE.exec(entry.name);
    if (!m) continue;
    const shardId = m[2] ?? "";
    // Defensive: a hand-renamed Syncthing conflict copy could match the
    // shard-id shape; conflict copies are never log shards.
    if (shardId.startsWith("sync-conflict")) continue;
    out.push({
      date: m[1]!,
      shardId,
      ext: m[3] as "jsonl" | "md",
      path: join(dir, entry.name),
      name: entry.name,
    });
  }
  return out;
}

/**
 * Sorted unique dates that have at least one log file (any shard, any
 * extension). The single date-discovery helper for every reader that
 * used to scan the directory itself.
 */
export function listLogDates(vault: string): string[] {
  const dates = new Set<string>();
  for (const f of listLogShardFiles(vault)) dates.add(f.date);
  return [...dates].toSorted();
}

/**
 * `Brain/log/*.sync-conflict-*` copies left behind by Syncthing. The
 * shard layout prevents NEW conflicts; doctor surfaces any leftovers
 * for a manual union+dedup merge.
 */
export function listLogSyncConflicts(vault: string): string[] {
  const dir = brainDirs(vault).log;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.includes(".sync-conflict-"))
    .map((e) => join(dir, e.name))
    .toSorted();
}

/** Markdown log files (legacy + shards) for doctor's per-file lint. */
export function listLogMarkdownFiles(vault: string): Array<{ date: string; path: string }> {
  return listLogShardFiles(vault)
    .filter((f) => f.ext === "md")
    .map((f) => ({ date: f.date, path: f.path }));
}

/**
 * Read one day of Brain log events, merged across every shard sorted
 * by (timestamp, shardId, line). Per shard the JSONL sidecar wins;
 * markdown is the fallback. When no file exists, returns an empty
 * result with `source: "jsonl"` (a convenient default — the caller
 * treats it as "no events for that date" regardless of source).
 */
export function readLogDay(vault: string, date: string): ReadLogDayResult {
  const validDate = validateIsoDate(date);
  const shards = listLogShardFiles(vault).filter((f) => f.date === validDate);
  if (shards.length === 0) return { entries: [], source: "jsonl", warnings: [] };

  // Group by shard id; per shard prefer .jsonl over .md.
  const byShard = new Map<string, { jsonl?: LogShardFile; md?: LogShardFile }>();
  for (const f of shards) {
    const slot = byShard.get(f.shardId) ?? {};
    slot[f.ext] = f;
    byShard.set(f.shardId, slot);
  }

  interface Tagged {
    readonly entry: BrainLogEntry;
    readonly shardId: string;
    readonly line: number;
  }
  const tagged: Tagged[] = [];
  const warnings: BrainLogParseWarning[] = [];
  let usedMarkdown = false;

  for (const shardId of [...byShard.keys()].toSorted()) {
    const slot = byShard.get(shardId)!;
    if (slot.jsonl) {
      const r = readJsonl(slot.jsonl.path);
      r.entries.forEach((entry, i) => tagged.push({ entry, shardId, line: i }));
      warnings.push(...r.warnings);
      continue;
    }
    if (slot.md) {
      usedMarkdown = true;
      const r = parseLogDayFile(vault, validDate, slot.md.path);
      r.entries.forEach((entry, i) => tagged.push({ entry, shardId, line: i }));
      warnings.push(...r.warnings);
    }
  }

  tagged.sort((a, b) => {
    if (a.entry.timestamp !== b.entry.timestamp) {
      return a.entry.timestamp < b.entry.timestamp ? -1 : 1;
    }
    if (a.shardId !== b.shardId) return a.shardId < b.shardId ? -1 : 1;
    return a.line - b.line;
  });

  return {
    entries: tagged.map((t) => t.entry),
    source: usedMarkdown ? "markdown-fallback" : "jsonl",
    warnings,
  };
}

interface ReadJsonlResult {
  readonly entries: ReadonlyArray<BrainLogEntry>;
  readonly warnings: ReadonlyArray<BrainLogParseWarning>;
}

function readJsonl(path: string): ReadJsonlResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // §23 (v0.10.8): we got here because the directory listing showed
    // the file, so a subsequent read error is anomalous (race with
    // rotation, permission flip, fs-transient) and worth surfacing
    // rather than reporting an empty shard. Discipline-report and any
    // future doctor can flag it without falling back to a silently
    // incomplete count.
    const message = (err as NodeJS.ErrnoException).message ?? String(err);
    return {
      entries: [],
      warnings: [{ path, lineNumber: 0, message: `failed to read JSONL file: ${message}` }],
    };
  }

  const entries: BrainLogEntry[] = [];
  const warnings: BrainLogParseWarning[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push({
        path,
        lineNumber: i + 1,
        message: `malformed JSONL line: ${line.slice(0, 80)}`,
      });
      continue;
    }
    const entry = coerceEntry(parsed, path, i + 1, warnings);
    if (entry !== null) entries.push(entry);
  }
  return { entries, warnings };
}

function coerceEntry(
  raw: unknown,
  path: string,
  lineNumber: number,
  warnings: BrainLogParseWarning[],
): BrainLogEntry | null {
  if (raw === null || typeof raw !== "object") {
    warnings.push({ path, lineNumber, message: "JSONL row is not an object" });
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const ts = obj["ts"];
  const kind = obj["kind"];
  const payload = obj["payload"];
  if (typeof ts !== "string" || typeof kind !== "string") {
    warnings.push({ path, lineNumber, message: "JSONL row missing ts/kind" });
    return null;
  }
  // `ts` must match the canonical ISO-8601 UTC shape produced by
  // `renderJsonlLine` (`YYYY-MM-DDTHH:MM:SSZ`, optional sub-second
  // precision). Anything looser would let arbitrary strings into
  // `BrainLogEntry.timestamp` and break downstream consumers that
  // assume the strict format (e.g. `parseIsoUtc` in `log.ts`).
  if (!ISO_UTC_TS_RE.test(ts)) {
    warnings.push({ path, lineNumber, message: `invalid ts format: ${ts}` });
    return null;
  }
  if (!BRAIN_LOG_EVENT_KIND_SET.has(kind)) {
    warnings.push({ path, lineNumber, message: `unknown event kind: ${kind}` });
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    warnings.push({
      path,
      lineNumber,
      message: "JSONL row missing payload object",
    });
    return null;
  }
  const body: Record<string, string | ReadonlyArray<string>> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof v === "string") {
      body[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      body[k] = v as string[];
    } else {
      warnings.push({
        path,
        lineNumber,
        message: `JSONL payload key '${k}' has unsupported value type`,
      });
    }
  }
  // Mirror `parseLogDay`: surface the payload agent at the top level so
  // jsonl- and markdown-sourced entries are interchangeable downstream.
  const agent = typeof body["agent"] === "string" ? body["agent"] : undefined;
  return {
    timestamp: ts,
    eventType: kind as BrainLogEventKind,
    ...(agent !== undefined ? { agent } : {}),
    body: Object.freeze(body),
  };
}
