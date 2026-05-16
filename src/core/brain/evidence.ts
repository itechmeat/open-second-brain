/**
 * Evidence aggregation: scan `Brain/log/<YYYY-MM-DD>.md` and surface
 * the apply-evidence rows that target a given preference. Used by
 * `dream` to rebuild the `## Recent applications` / `## Recent
 * violations` sections of every preference and retired file on each
 * pass, so the file mirrors what the counters say.
 *
 * Pure read: no I/O outside reading log files.
 */

import { existsSync, readdirSync } from "node:fs";

import { brainDirs } from "./paths.ts";
import { parseLogDay } from "./log.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  type BrainApplyResult,
  type BrainEvidenceSummary,
} from "./types.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";

/** Strip `[[` / `]]` plus a trailing `|alt` segment. */
function unwrap(wikilink: string): string {
  return normaliseWikilinkTarget(wikilink) ?? wikilink.trim();
}

function eqId(eventPrefRef: string, slug: string): boolean {
  const bare = unwrap(eventPrefRef);
  return bare === `pref-${slug}` || bare === `ret-${slug}`;
}

/** Sorted list of `YYYY-MM-DD` log days actually on disk. Newest first. */
export function listLogDays(vault: string): string[] {
  const dir = brainDirs(vault).log;
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const days: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const day = name.slice(0, -3);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    days.push(day);
  }
  days.sort();
  days.reverse();
  return days;
}

export interface CollectEvidenceOptions {
  /** Maximum `applied` rows to return. Default 5. */
  readonly maxApplied?: number;
  /** Maximum `violated`/`outdated` rows to return. Default 3. */
  readonly maxViolated?: number;
  /**
   * Stop scanning at this ISO timestamp (inclusive). **Required** —
   * the caller MUST pass the preference's `created_at` so we never
   * harvest log rows that predate the pref's existence (which would
   * be a different rule under the same slug history). Pass an empty
   * string to opt out and scan every available log day (only useful
   * for vault-wide ad-hoc tooling).
   */
  readonly sinceIso: string;
}

export interface CollectedEvidence {
  readonly applied: ReadonlyArray<BrainEvidenceSummary>;
  readonly violated: ReadonlyArray<BrainEvidenceSummary>;
}

/**
 * Walk log files newest-first, collecting at most `maxApplied`
 * `apply-evidence applied` rows and at most `maxViolated`
 * `violated` / `outdated` rows that target `pref-<slug>` (or its
 * `ret-<slug>` post-retire identity).
 *
 * Stops early once both quotas are full.
 */
export function collectEvidenceForSlug(
  vault: string,
  slug: string,
  opts: CollectEvidenceOptions,
): CollectedEvidence {
  const maxApplied = opts.maxApplied ?? 5;
  const maxViolated = opts.maxViolated ?? 3;
  // Empty string is the documented "no cutoff" escape hatch.
  const cutoff = opts.sinceIso.length > 0 ? opts.sinceIso : null;

  const applied: BrainEvidenceSummary[] = [];
  const violated: BrainEvidenceSummary[] = [];

  for (const day of listLogDays(vault)) {
    if (cutoff && day < cutoff.slice(0, 10)) break;
    const { entries } = parseLogDay(vault, day);
    // parseLogDay returns entries in file order (oldest first). We want
    // newest first across the whole vault, so iterate in reverse.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      if (cutoff && e.timestamp < cutoff) continue;
      const prefRef = e.body["preference"];
      if (typeof prefRef !== "string" || !eqId(prefRef, slug)) continue;
      const result = e.body["result"];
      if (typeof result !== "string") continue;
      const artifact = typeof e.body["artifact"] === "string" ? e.body["artifact"] : "";
      const agent = typeof e.body["agent"] === "string" ? e.body["agent"] : undefined;
      const note = typeof e.body["note"] === "string" ? e.body["note"] : undefined;
      const row: BrainEvidenceSummary = Object.freeze({
        timestamp: e.timestamp,
        artifact,
        result: result as BrainApplyResult,
        ...(agent !== undefined ? { agent } : {}),
        ...(note !== undefined ? { note } : {}),
      });
      if (result === BRAIN_APPLY_RESULT.applied) {
        if (applied.length < maxApplied) applied.push(row);
      } else if (
        result === BRAIN_APPLY_RESULT.violated ||
        result === BRAIN_APPLY_RESULT.outdated
      ) {
        if (violated.length < maxViolated) violated.push(row);
      }
      if (applied.length >= maxApplied && violated.length >= maxViolated) {
        return Object.freeze({
          applied: Object.freeze(applied),
          violated: Object.freeze(violated),
        });
      }
    }
  }

  return Object.freeze({
    applied: Object.freeze(applied),
    violated: Object.freeze(violated),
  });
}
