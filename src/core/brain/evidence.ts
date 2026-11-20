/**
 * Evidence aggregation: scan `Brain/log/<YYYY-MM-DD>.md` and surface
 * the apply-evidence rows that target a given preference. Used by
 * `dream` to rebuild the `## Recent applications` / `## Recent
 * violations` sections of every preference and retired file on each
 * pass, so the file mirrors what the counters say.
 *
 * Pure read: no I/O outside reading log files.
 *
 * ## Private evidence on a shared preference (task 3.18)
 *
 * On a store-only machine an `apply-evidence` event lands in `private`
 * when its artifact or note names a private page, even when the
 * preference it targets is shared. Such an event never counts toward a
 * shared preference: the counters, the status, the confidence and the
 * `## Recent ...` sections it would move live on the shared preference
 * record, which every machine and remote caller reads, so counting it
 * would publish what the private partition holds. It counts toward a
 * preference that is itself private, whose record stays in `private`.
 * The event stays in this machine's private log, where a local reader
 * sees it. {@link privateEvidenceCounts} is the one rule both the dream
 * scan and this collector apply.
 */

import { storePreferenceEntry } from "./preference-store.ts";
import { logDayReader } from "./log-days.ts";
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
  // Shard-aware (Memory Integrity Suite): one discovery helper for
  // every log filename shape, legacy and sharded.
  let days: string[];
  try {
    days = [...logDayReader(vault).dates];
  } catch {
    return [];
  }
  days.reverse();
  return days;
}

/**
 * Whether a private `apply-evidence` event may count toward the preference
 * `pref-<slug>`: only when that preference is known to be private. A
 * preference the store does not resolve takes none (fail closed: counting
 * could publish the event on a shared record).
 */
export function privateEvidenceCounts(slug: string): boolean {
  try {
    return storePreferenceEntry(slug)?.private === true;
  } catch {
    return false;
  }
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
/**
 * The log events the dream pass's evidence readers use (this module and
 * `dream-refresh.ts` `scanApplyEvidence`): one set, so the pass reads the
 * store log for them once (`log-days.ts` read pass) and holds only those.
 */
export const EVIDENCE_LOG_EVENTS: ReadonlySet<string> = new Set([
  BRAIN_LOG_EVENT_KIND.applyEvidence,
  BRAIN_LOG_EVENT_KIND.merge,
]);

export function collectEvidenceForSlug(
  vault: string | null,
  slug: string,
  opts: CollectEvidenceOptions,
): CollectedEvidence {
  const maxApplied = opts.maxApplied ?? 5;
  const maxViolated = opts.maxViolated ?? 3;
  // Empty string is the documented "no cutoff" escape hatch.
  const cutoff = opts.sinceIso.length > 0 ? opts.sinceIso : null;

  const applied: BrainEvidenceSummary[] = [];
  const violated: BrainEvidenceSummary[] = [];

  // An unreadable log is no evidence, as it always was: never a throw out
  // of a reader the dream pass calls once per preference. Only the days
  // from the cutoff on are read.
  let log: ReturnType<typeof logDayReader>;
  let dates: ReadonlyArray<string>;
  try {
    log = logDayReader(vault, {
      ...(cutoff !== null ? { from: cutoff.slice(0, 10) } : {}),
      eventTypes: EVIDENCE_LOG_EVENTS,
    });
    dates = log.dates;
  } catch {
    return { applied, violated };
  }
  let takesPrivate: boolean | undefined;
  for (const day of dates.toReversed()) {
    if (cutoff && day < cutoff.slice(0, 10)) break;
    const { entries } = log.day(day);
    // readLogDay returns entries in merged order (oldest first). We want
    // newest first across the whole vault, so iterate in reverse.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      if (cutoff && e.timestamp < cutoff) continue;
      const prefRef = e.body["preference"];
      if (typeof prefRef !== "string" || !eqId(prefRef, slug)) continue;
      if (e.fromPrivatePartition === true && !(takesPrivate ??= privateEvidenceCounts(slug))) {
        continue;
      }
      const result = e.body["result"];
      if (typeof result !== "string") continue;
      const artifact = typeof e.body["artifact"] === "string" ? e.body["artifact"] : "";
      const agent = typeof e.body["agent"] === "string" ? e.body["agent"] : undefined;
      const note = typeof e.body["note"] === "string" ? e.body["note"] : undefined;
      const outcomeRaw = e.body["outcome"];
      const outcome =
        outcomeRaw === "success" || outcomeRaw === "failure"
          ? (outcomeRaw as BrainEvidenceSummary["outcome"])
          : undefined;
      const row: BrainEvidenceSummary = Object.freeze({
        timestamp: e.timestamp,
        artifact,
        result: result as BrainApplyResult,
        ...(agent !== undefined ? { agent } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
      });
      if (result === BRAIN_APPLY_RESULT.applied) {
        if (applied.length < maxApplied) applied.push(row);
      } else if (result === BRAIN_APPLY_RESULT.violated || result === BRAIN_APPLY_RESULT.outdated) {
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
