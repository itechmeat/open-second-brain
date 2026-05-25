/**
 * Shared helpers used by both `buildDailyBrief` and
 * `buildWeeklySynthesis`. Extracted so the two surface modules carry
 * one canonical implementation of wikilink-id extraction, transition
 * extraction from dream summaries, vault-delta counting, and source
 * pointer deduplication.
 */

import { parseWikilink } from "./../wikilink.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  type BrainLogEventKind,
} from "./../types.ts";
import type { TemporalEvent } from "./types.ts";

const LINK_REASON_RE = /\(([^)]+)\)\s*$/;
const ID_PREFIX_RE = /^(pref|ret)-[A-Za-z0-9-]+$/;

/** Status transition entry shared by daily / weekly briefs. */
export interface PeriodStatusTransition {
  readonly at: string;
  readonly kind: "creation" | "promotion" | "retirement";
  readonly prefId: string;
  readonly link: string;
}

export interface PeriodVaultDelta {
  readonly newPromotions: number;
  readonly newRetired: number;
  readonly newFeedback: number;
  readonly evidenceApplied: number;
  readonly evidenceViolated: number;
}

/** Count events by their `kind` slot, returning a partial record. */
export function countByKind(
  events: ReadonlyArray<TemporalEvent>,
): Partial<Record<BrainLogEventKind, number>> {
  const out: Partial<Record<BrainLogEventKind, number>> = {};
  for (const ev of events) {
    out[ev.kind] = (out[ev.kind] ?? 0) + 1;
  }
  return out;
}

/**
 * Walk dream summary events in `events`, extract per-id transitions
 * from `new_unconfirmed` / `confirmed` / `retired` arrays, and return
 * them in chronological order.
 */
export function collectTransitions(
  events: ReadonlyArray<TemporalEvent>,
): PeriodStatusTransition[] {
  const out: PeriodStatusTransition[] = [];
  for (const ev of events) {
    if (ev.kind !== BRAIN_LOG_EVENT_KIND.dream) continue;
    const summary = ev.dreamSummary;
    if (summary === undefined) continue;
    appendTransitions(ev.at, summary.newUnconfirmed, "creation", out);
    appendTransitions(ev.at, summary.confirmed, "promotion", out);
    appendTransitions(ev.at, summary.retired, "retirement", out);
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

function appendTransitions(
  at: string,
  links: ReadonlyArray<string> | undefined,
  kind: PeriodStatusTransition["kind"],
  out: PeriodStatusTransition[],
): void {
  if (links === undefined) return;
  for (const link of links) {
    const id = extractId(link);
    if (id === undefined) continue;
    out.push(Object.freeze({ at, kind, prefId: id, link }));
  }
}

/** Derive per-window counters from event list + already-computed transitions. */
export function computeVaultDelta(
  events: ReadonlyArray<TemporalEvent>,
  transitions: ReadonlyArray<PeriodStatusTransition>,
): PeriodVaultDelta {
  let newPromotions = 0;
  let newRetired = 0;
  for (const t of transitions) {
    if (t.kind === "promotion") newPromotions++;
    if (t.kind === "retirement") newRetired++;
  }
  let newFeedback = 0;
  let evidenceApplied = 0;
  let evidenceViolated = 0;
  for (const ev of events) {
    if (ev.kind === BRAIN_LOG_EVENT_KIND.feedback) newFeedback++;
    if (ev.kind === BRAIN_LOG_EVENT_KIND.applyEvidence) {
      if (ev.result === BRAIN_APPLY_RESULT.applied) evidenceApplied++;
      if (ev.result === BRAIN_APPLY_RESULT.violated) evidenceViolated++;
    }
  }
  return {
    newPromotions,
    newRetired,
    newFeedback,
    evidenceApplied,
    evidenceViolated,
  };
}

/** Deduplicated list of artifact wikilinks cited by apply-evidence rows. */
export function collectSourcePointers(
  events: ReadonlyArray<TemporalEvent>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ev of events) {
    if (ev.kind !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
    if (ev.artifact === undefined) continue;
    if (seen.has(ev.artifact)) continue;
    seen.add(ev.artifact);
    out.push(ev.artifact);
  }
  return out;
}

/**
 * Pull a pref / ret id out of a wikilink body that may carry an alias
 * and / or a trailing `(reason)` decoration. Returns `undefined` when
 * the body doesn't look like a documented id.
 */
export function extractId(linkOrId: string): string | undefined {
  const stripped = linkOrId.replace(LINK_REASON_RE, "").trim();
  const target = parseWikilink(stripped) ?? stripped;
  return ID_PREFIX_RE.test(target) ? target : undefined;
}
