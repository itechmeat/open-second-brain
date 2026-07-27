/**
 * The pre-parsed views of the Brain store the checks read.
 *
 * Built once per pass and handed round on the check context, so the
 * three preference-walking lints do not each re-parse
 * `Brain/preferences/` and the two log-walking lints do not each re-read
 * `Brain/log/`.
 *
 * Each reader takes an optional sweep sink. WITH one - the doctor pass,
 * which resolves this context before any check runs and therefore before
 * anything can report - a directory it cannot read is named in the
 * uncertainty stream and the pass continues; without one, the failure
 * propagates to the caller exactly as it always has. There is no third
 * behaviour: nothing here turns an unread directory into an empty one.
 */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { listLogDates, readLogDay } from "../log-jsonl.ts";
import { brainDirs } from "../paths.ts";
import { parsePreference } from "../preference.ts";
import {
  readSweptDir,
  reportSweptFailure,
  SWEEP_ORIGIN,
  type SweptPath,
} from "./unreadable-path.ts";

export interface PreferenceRecord {
  readonly path: string;
  readonly pref: import("../types.ts").BrainPreference;
}

export interface LogRecord {
  readonly date: string;
  readonly entries: ReadonlyArray<import("../log.ts").BrainLogEntry>;
}

/**
 * The entries of `dir`, or `null` when there are none to read.
 *
 * The `existsSync` gate lives only on the sink-less path, where "absent"
 * is the only fail-soft answer the caller ever had. With a sink the same
 * question is asked of the failure itself, because `existsSync` answers
 * false for a permission denial on a parent component as readily as for
 * a directory nobody created - and those are different findings.
 */
function listRecordDir(dir: string, swept: SweptPath | undefined): Dirent[] | null {
  if (swept !== undefined) return readSweptDir(dir, swept, SWEEP_ORIGIN.root);
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { withFileTypes: true });
}

/**
 * Build a single pre-parsed snapshot of `Brain/preferences/` so the
 * three pref-walking lints don't each re-parse the directory.
 * Files that fail to parse are silently omitted — schema errors are
 * already reported by the preference record check.
 */
export function readAllPreferenceRecords(
  vault: string,
  swept?: SweptPath,
): ReadonlyArray<PreferenceRecord> {
  const dirs = brainDirs(vault);
  const entries = listRecordDir(dirs.preferences, swept);
  if (entries === null) return [];
  const out: PreferenceRecord[] = [];
  for (const entry of entries) {
    const name = entry.name;
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
export function readAllLogRecords(vault: string, swept?: SweptPath): ReadonlyArray<LogRecord> {
  // Shard-aware (Memory Integrity Suite): dates come from the single
  // discovery helper and entries arrive merged across device shards.
  const out: LogRecord[] = [];
  for (const date of listLogDatesSwept(vault, swept)) {
    try {
      out.push({ date, entries: readLogDay(vault, date).entries });
    } catch {
      // parse error — surfaced separately by the log shard check
    }
  }
  return out;
}

/**
 * The dates the log directory holds. Discovery is behind a shared
 * helper, so a `Brain/log` that is a regular file arrives here as a
 * throw - which, resolved before any check runs, ended the whole pass
 * with no findings at all.
 */
function listLogDatesSwept(vault: string, swept: SweptPath | undefined): ReadonlyArray<string> {
  if (swept === undefined) return listLogDates(vault);
  try {
    return listLogDates(vault);
  } catch (err) {
    reportSweptFailure(
      brainDirs(vault).log,
      "log date discovery failed",
      err,
      swept,
      SWEEP_ORIGIN.root,
    );
    return [];
  }
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
export function collectAllBasenames(vault: string, swept?: SweptPath): ReadonlySet<string> {
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
    const entries = listRecordDir(d, swept);
    if (entries === null) continue;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      out.add(entry.name.slice(0, -".md".length));
    }
  }
  return out;
}
