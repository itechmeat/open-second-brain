/**
 * Sliding 30-day applied-evidence ranker that backs the
 * `## Most-applied (30d)` section of `Brain/active.md`.
 *
 * Pure read. Caller passes the candidate preferences (already
 * filtered to `confirmed | quarantine` in `regenerateActive`); this
 * module never re-walks the preferences directory.
 */

import { existsSync, readdirSync } from "node:fs";

import { brainDirs } from "./paths.ts";
import { readLogDay } from "./log-jsonl.ts";
import {
  MOST_APPLIED_LIMIT_DEFAULT,
  MOST_APPLIED_WINDOW_DAYS_DEFAULT,
} from "./policy.ts";
import { isoDate } from "./time.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  type BrainPreference,
} from "./types.ts";

const DAY_MS = 24 * 3600 * 1000;
const LOG_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export interface MostAppliedEntry {
  readonly preference: BrainPreference;
  readonly applied_30d: number;
}

export interface ComputeMostAppliedOptions {
  /** Window anchor. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Window length in days. Defaults to 30. */
  readonly windowDays?: number;
  /** Max entries returned. Defaults to 10. */
  readonly limit?: number;
}

/**
 * Compute the Most-applied list for the `active.md` section.
 *
 * @param vault       Vault root.
 * @param preferences Candidate preferences (confirmed | quarantine).
 *                    Events referencing preferences outside this list
 *                    are silently ignored by design — retired rules
 *                    do not appear in `active.md`.
 */
export function computeMostApplied(
  vault: string,
  preferences: ReadonlyArray<BrainPreference>,
  opts: ComputeMostAppliedOptions = {},
): ReadonlyArray<MostAppliedEntry> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? MOST_APPLIED_WINDOW_DAYS_DEFAULT;
  const limit = opts.limit ?? MOST_APPLIED_LIMIT_DEFAULT;
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return [];

  // The caller is supposed to filter to confirmed | quarantine upstream,
  // but the status guard here keeps the contract honest if a future
  // caller passes a wider list — retired rules must never surface in
  // the active digest.
  const prefByKey = new Map<string, BrainPreference>();
  for (const p of preferences) {
    if (
      p.status !== BRAIN_PREFERENCE_STATUS.confirmed &&
      p.status !== BRAIN_PREFERENCE_STATUS.quarantine
    ) {
      continue;
    }
    prefByKey.set(normaliseWikilinkTarget(p.id), p);
  }
  if (prefByKey.size === 0) return [];

  const windowEndMs = now.getTime();
  const windowStartMs = windowEndMs - windowDays * DAY_MS;
  // Day-level fence: include the day before window start to absorb
  // UTC drift between the event timestamp and the file's date prefix.
  const earliestDayPrefix = isoDate(new Date(windowStartMs - DAY_MS));

  const counts = new Map<string, number>();
  for (const name of readdirSync(dirs.log)) {
    const m = LOG_FILENAME_RE.exec(name);
    if (!m) continue;
    const datePrefix = m[1]!;
    if (datePrefix < earliestDayPrefix) continue;

    let parsed;
    try {
      parsed = readLogDay(vault, datePrefix);
    } catch (err) {
      process.stderr.write(
        `warning: most-applied: failed to read ${datePrefix}: ${(err as Error).message}\n`,
      );
      continue;
    }
    for (const e of parsed.entries) {
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      if (e.body["result"] !== BRAIN_APPLY_RESULT.applied) continue;
      const eventMs = Date.parse(e.timestamp);
      if (Number.isNaN(eventMs)) continue;
      if (eventMs < windowStartMs || eventMs > windowEndMs) continue;
      const prefField = e.body["preference"];
      if (typeof prefField !== "string") continue;
      const key = normaliseWikilinkTarget(prefField);
      if (!prefByKey.has(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const entries: MostAppliedEntry[] = [];
  for (const [key, count] of counts) {
    const pref = prefByKey.get(key)!;
    entries.push({ preference: pref, applied_30d: count });
  }
  entries.sort((a, b) => {
    if (b.applied_30d !== a.applied_30d) return b.applied_30d - a.applied_30d;
    return a.preference.id.localeCompare(b.preference.id);
  });
  return entries.slice(0, limit);
}
