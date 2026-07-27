/**
 * The pre-parsed views of the Brain store the checks read.
 *
 * Built once per pass and handed round on the check context, so the
 * three preference-walking lints do not each re-parse
 * `Brain/preferences/` and the two log-walking lints do not each re-read
 * `Brain/log/`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { listLogDates, readLogDay } from "../log-jsonl.ts";
import { brainDirs } from "../paths.ts";
import { parsePreference } from "../preference.ts";

export interface PreferenceRecord {
  readonly path: string;
  readonly pref: import("../types.ts").BrainPreference;
}

export interface LogRecord {
  readonly date: string;
  readonly entries: ReadonlyArray<import("../log.ts").BrainLogEntry>;
}

/**
 * Build a single pre-parsed snapshot of `Brain/preferences/` so the
 * three pref-walking lints don't each re-parse the directory.
 * Files that fail to parse are silently omitted — schema errors are
 * already reported by the preference record check.
 */
export function readAllPreferenceRecords(vault: string): ReadonlyArray<PreferenceRecord> {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return [];
  const out: PreferenceRecord[] = [];
  for (const name of readdirSync(dirs.preferences)) {
    if (!name.endsWith(".md") || !name.startsWith("pref-")) continue;
    const path = join(dirs.preferences, name);
    try {
      out.push({ path, pref: parsePreference(path) });
    } catch {
      // schema error — reported by the preference record check
    }
  }
  return out;
}

/**
 * Build a single pre-parsed snapshot of `Brain/log/` so the two
 * log-walking lints don't each re-parse the directory.
 */
export function readAllLogRecords(vault: string): ReadonlyArray<LogRecord> {
  // Shard-aware (Memory Integrity Suite): dates come from the single
  // discovery helper and entries arrive merged across device shards.
  const out: LogRecord[] = [];
  for (const date of listLogDates(vault)) {
    try {
      out.push({ date, entries: readLogDay(vault, date).entries });
    } catch {
      // parse error — surfaced separately by the log shard check
    }
  }
  return out;
}

/**
 * Build the universe of valid wikilink targets inside `Brain/`. The
 * doctor pass is scoped to Brain content; cross-layer wikilinks
 * pointing at user-authored notes outside Brain/ are out of scope
 * and stay accepted.
 *
 * Set is keyed by basename (without `.md`) so Obsidian's basename
 * match works.
 */
export function collectAllBasenames(vault: string): ReadonlySet<string> {
  const out = new Set<string>();
  const dirs = brainDirs(vault);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
  ]) {
    if (!existsSync(d)) continue;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      out.add(entry.name.slice(0, -".md".length));
    }
  }
  return out;
}
