/**
 * `buildDailyBrief(index, vault, date, cfg?)` - per-day deterministic
 * summary used by the daily-brief surface.
 *
 * Pure projection over the `TimelineIndex`: filters events to a single
 * day window (UTC by default; configurable via
 * `temporal.daily_window_offset_hours`), counts them by kind, derives
 * status transitions from dream summary arrays, computes the per-day
 * vault delta, and deduplicates the cited artifact wikilinks.
 *
 * Design anchor: `docs/brainstorm/temporal-synthesis/design.md`,
 * Task 6 in `plan.md`.
 */

import { parseWikilink } from "./../wikilink.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  type BrainLogEventKind,
} from "./../types.ts";
import { selectEvents } from "./select-events.ts";
import type { TemporalEvent, TimelineIndex } from "./types.ts";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LINK_REASON_RE = /\(([^)]+)\)\s*$/;
const ID_PREFIX_RE = /^(pref|ret)-[A-Za-z0-9-]+$/;

export interface DailyStatusTransition {
  readonly at: string;
  readonly kind: "creation" | "promotion" | "retirement";
  readonly prefId: string;
  readonly link: string;
}

export interface DailyVaultDelta {
  readonly newPromotions: number;
  readonly newRetired: number;
  readonly newFeedback: number;
  readonly evidenceApplied: number;
  readonly evidenceViolated: number;
}

export interface DailyBriefEnvelope {
  readonly date: string;
  readonly window: { readonly since: string; readonly until: string };
  readonly eventsByKind: Readonly<Partial<Record<BrainLogEventKind, number>>>;
  readonly statusTransitions: ReadonlyArray<DailyStatusTransition>;
  readonly vaultDelta: DailyVaultDelta;
  readonly sourcePointers: ReadonlyArray<string>;
  readonly generatedAt: string;
}

export interface BuildDailyBriefOptions {
  /** Offset hours from UTC for the day boundary; range [-23, 23]. Default 0. */
  readonly offsetHours?: number;
  /** Wall clock for `generatedAt`; defaults to `new Date()`. */
  readonly now?: Date;
}

export function buildDailyBrief(
  index: TimelineIndex,
  _vault: string,
  date: string,
  opts: BuildDailyBriefOptions = {},
): DailyBriefEnvelope {
  // `_vault` is part of the helper signature for parity with
  // sibling projections; the brief itself is a pure projection over
  // the index and does not re-touch disk.
  const offsetHours = opts.offsetHours ?? 0;
  const window = dailyWindow(date, offsetHours);
  const generatedAt = (opts.now ?? new Date()).toISOString();

  const dayEvents = selectEvents(index, {
    since: window.since,
    until: window.until,
  });

  const eventsByKind: Partial<Record<BrainLogEventKind, number>> = {};
  for (const ev of dayEvents) {
    eventsByKind[ev.kind] = (eventsByKind[ev.kind] ?? 0) + 1;
  }

  const transitions = collectDailyTransitions(dayEvents);
  const vaultDelta = computeVaultDelta(dayEvents, transitions);
  const sourcePointers = collectSourcePointers(dayEvents);

  return Object.freeze({
    date,
    window,
    eventsByKind: Object.freeze(eventsByKind),
    statusTransitions: Object.freeze(transitions),
    vaultDelta: Object.freeze(vaultDelta),
    sourcePointers: Object.freeze(sourcePointers),
    generatedAt,
  });
}

function dailyWindow(
  date: string,
  offsetHours: number,
): { readonly since: string; readonly until: string } {
  const dayStartMs = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(dayStartMs)) {
    throw new Error(`buildDailyBrief: invalid date ${JSON.stringify(date)}`);
  }
  const offsetMs = offsetHours * ONE_HOUR_MS;
  return Object.freeze({
    since: new Date(dayStartMs - offsetMs).toISOString(),
    until: new Date(dayStartMs - offsetMs + ONE_DAY_MS).toISOString(),
  });
}

function collectDailyTransitions(
  events: ReadonlyArray<TemporalEvent>,
): DailyStatusTransition[] {
  const out: DailyStatusTransition[] = [];
  for (const ev of events) {
    if (ev.kind !== BRAIN_LOG_EVENT_KIND.dream) continue;
    const summary = ev.dreamSummary;
    if (summary === undefined) continue;
    appendTransitionsFromLinks(ev.at, summary.newUnconfirmed, "creation", out);
    appendTransitionsFromLinks(ev.at, summary.confirmed, "promotion", out);
    appendTransitionsFromLinks(ev.at, summary.retired, "retirement", out);
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

function appendTransitionsFromLinks(
  at: string,
  links: ReadonlyArray<string> | undefined,
  kind: DailyStatusTransition["kind"],
  out: DailyStatusTransition[],
): void {
  if (links === undefined) return;
  for (const link of links) {
    const id = extractId(link);
    if (id === undefined) continue;
    out.push(Object.freeze({ at, kind, prefId: id, link }));
  }
}

function computeVaultDelta(
  events: ReadonlyArray<TemporalEvent>,
  transitions: ReadonlyArray<DailyStatusTransition>,
): DailyVaultDelta {
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

function collectSourcePointers(
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

function extractId(linkOrId: string): string | undefined {
  const stripped = linkOrId.replace(LINK_REASON_RE, "").trim();
  const target = parseWikilink(stripped) ?? stripped;
  return ID_PREFIX_RE.test(target) ? target : undefined;
}
