/**
 * Brain log reader (§23, v0.10.8). Prefers the JSONL sidecar written by
 * `appendLogEvent`; falls back to parsing the markdown on days without
 * a sidecar (pre-v0.10.8 history, or sidecar deleted by hand).
 *
 * Every machine consumer of `Brain/log/` (discipline-report today,
 * future tooling tomorrow) reads through this entry point so the
 * fallback logic never duplicates. Malformed JSONL lines surface as
 * `warnings` instead of aborting the read, matching `parseLogDay`'s
 * tolerance contract.
 */

import { existsSync, readFileSync } from "node:fs";

import { logJsonlPath, logPath, validateIsoDate } from "./paths.ts";
import {
  parseLogDay,
  type BrainLogEntry,
  type BrainLogParseWarning,
} from "./log.ts";
import {
  BRAIN_LOG_EVENT_KIND_SET,
  type BrainLogEventKind,
} from "./types.ts";

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

/**
 * Read one day of Brain log events. Picks the JSONL sidecar when it
 * exists; otherwise falls back to parsing the markdown. When neither
 * file exists, returns an empty result with `source: "jsonl"` (a
 * convenient default — the caller treats it as "no events for that
 * date" regardless of source).
 */
export function readLogDay(vault: string, date: string): ReadLogDayResult {
  const validDate = validateIsoDate(date);
  const mdPath = logPath(vault, validDate);
  const jsonlPath = logJsonlPath(vault, validDate);

  if (existsSync(jsonlPath)) {
    return readJsonl(jsonlPath);
  }
  if (existsSync(mdPath)) {
    const parsed = parseLogDay(vault, validDate);
    return {
      entries: parsed.entries,
      source: "markdown-fallback",
      warnings: parsed.warnings,
    };
  }
  return { entries: [], source: "jsonl", warnings: [] };
}

function readJsonl(path: string): ReadLogDayResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // §23 (v0.10.8): we got here because `existsSync(jsonlPath)`
    // returned true, so a subsequent read error is anomalous (race
    // with rotation, permission flip, fs-transient) and worth
    // surfacing rather than reporting an empty day. Discipline-report
    // and any future doctor can flag it without falling back to a
    // silently incomplete count.
    const message = (err as NodeJS.ErrnoException).message ?? String(err);
    return {
      entries: [],
      source: "jsonl",
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
  return { entries, source: "jsonl", warnings };
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
  return {
    timestamp: ts,
    eventType: kind as BrainLogEventKind,
    body: Object.freeze(body),
  };
}
