import { storePreferenceEntry } from "./preference-store.ts";
import {
  EVIDENCE_LOG_EVENTS,
  matchEvidenceForSlug,
  type CollectEvidenceOptions,
} from "./evidence.ts";
import { logDayReader } from "./log-days.ts";
import type { BrainLogEntry } from "./log.ts";

export interface EvidenceDay {
  readonly date: string;
  readonly entries: ReadonlyArray<BrainLogEntry>;
}

/** Read each evidence day once, in the pass's checkpoint order. */
export function readEvidenceDays(
  vault: string | null,
  checkpoint: () => void = () => {},
): EvidenceDay[] {
  const log = logDayReader(vault, { eventTypes: EVIDENCE_LOG_EVENTS });
  const days: EvidenceDay[] = [];
  for (const date of log.dates) {
    checkpoint();
    days.push({ date, entries: log.day(date).entries });
  }
  return days;
}

/** Sorted list of `YYYY-MM-DD` log days actually on disk, newest first. */
export function listLogDays(vault: string): string[] {
  try {
    return logDayReader(vault).dates.toReversed();
  } catch {
    return [];
  }
}

/** Whether a private event can count toward the named preference. */
export function privateEvidenceCounts(slug: string): boolean {
  try {
    return storePreferenceEntry(slug)?.private === true;
  } catch {
    return false;
  }
}

/** Read-backed compatibility API for callers outside a dream pass. */
export function collectEvidenceForSlug(
  vault: string | null,
  slug: string,
  opts: CollectEvidenceOptions,
) {
  let events: BrainLogEntry[];
  try {
    const cutoff = opts.sinceIso.length > 0 ? opts.sinceIso : null;
    const log = logDayReader(vault, {
      ...(cutoff !== null ? { from: cutoff.slice(0, 10) } : {}),
      eventTypes: EVIDENCE_LOG_EVENTS,
    });
    events = log.dates.flatMap((date) => log.day(date).entries);
  } catch {
    return { applied: [], violated: [] };
  }
  return matchEvidenceForSlug(events, slug, opts, privateEvidenceCounts);
}
