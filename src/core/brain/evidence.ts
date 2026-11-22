import type { BrainLogEntry } from "./log.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  type BrainApplyResult,
  type BrainEvidenceSummary,
} from "./types.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";

/** The log events used by the dream evidence read. */
export const EVIDENCE_LOG_EVENTS: ReadonlySet<string> = new Set([
  BRAIN_LOG_EVENT_KIND.applyEvidence,
  BRAIN_LOG_EVENT_KIND.merge,
]);

export interface CollectEvidenceOptions {
  readonly maxApplied?: number;
  readonly maxViolated?: number;
  readonly sinceIso: string;
}

export interface CollectedEvidence {
  readonly applied: ReadonlyArray<BrainEvidenceSummary>;
  readonly violated: ReadonlyArray<BrainEvidenceSummary>;
}

function unwrap(wikilink: string): string {
  return normaliseWikilinkTarget(wikilink) ?? wikilink.trim();
}

function eqId(eventPrefRef: string, slug: string): boolean {
  const bare = unwrap(eventPrefRef);
  return bare === `pref-${slug}` || bare === `ret-${slug}`;
}

/** Match one preference's evidence from an already-read event window. */
export function matchEvidenceForSlug(
  events: ReadonlyArray<BrainLogEntry>,
  slug: string,
  opts: CollectEvidenceOptions,
  privateCounts: (slug: string) => boolean,
): CollectedEvidence {
  const maxApplied = opts.maxApplied ?? 5;
  const maxViolated = opts.maxViolated ?? 3;
  const cutoff = opts.sinceIso.length > 0 ? opts.sinceIso : null;
  const applied: BrainEvidenceSummary[] = [];
  const violated: BrainEvidenceSummary[] = [];
  let takesPrivate: boolean | undefined;

  let start = 0;
  if (cutoff) {
    let low = 0;
    let high = events.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (events[middle]!.timestamp < cutoff) low = middle + 1;
      else high = middle;
    }
    start = low;
  }

  for (let i = events.length - 1; i >= start; i--) {
    const event = events[i]!;
    if (event.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
    if (cutoff && event.timestamp < cutoff) continue;
    const prefRef = event.body["preference"];
    if (typeof prefRef !== "string" || !eqId(prefRef, slug)) continue;
    if (event.fromPrivatePartition === true && !(takesPrivate ??= privateCounts(slug))) continue;
    const result = event.body["result"];
    if (typeof result !== "string") continue;
    const artifact = typeof event.body["artifact"] === "string" ? event.body["artifact"] : "";
    const agent = typeof event.body["agent"] === "string" ? event.body["agent"] : undefined;
    const note = typeof event.body["note"] === "string" ? event.body["note"] : undefined;
    const outcomeRaw = event.body["outcome"];
    const outcome =
      outcomeRaw === "success" || outcomeRaw === "failure"
        ? (outcomeRaw as BrainEvidenceSummary["outcome"])
        : undefined;
    const row: BrainEvidenceSummary = Object.freeze({
      timestamp: event.timestamp,
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
    if (applied.length >= maxApplied && violated.length >= maxViolated) break;
  }

  return Object.freeze({ applied: Object.freeze(applied), violated: Object.freeze(violated) });
}
