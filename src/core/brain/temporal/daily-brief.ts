/**
 * `buildDailyBrief(index, vault, date, opts?)` - per-day deterministic
 * summary used by the daily-brief surface.
 *
 * Pure projection over the `TimelineIndex`: filters events to a single
 * day window (UTC by default; configurable via
 * `temporal.daily_window_offset_hours`), counts them by kind, derives
 * status transitions from dream summary arrays, computes the per-day
 * vault delta, and deduplicates the cited artifact wikilinks.
 *
 * Shared period helpers live in `period-common.ts`. Vault parameter is
 * kept on the signature for parity with sibling projections; the brief
 * does not re-touch disk.
 *
 * Design anchor: `docs/brainstorm/temporal-synthesis/design.md`,
 * Task 6 in `plan.md`.
 */

import { isoSecond } from "./../time.ts";
import type { BrainLogEventKind } from "./../types.ts";
import { selectEvents } from "./select-events.ts";
import {
  collectSourcePointers,
  collectTransitions,
  computeVaultDelta,
  countByKind,
  type PeriodStatusTransition,
  type PeriodVaultDelta,
} from "./period-common.ts";
import type { TimelineIndex } from "./types.ts";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyBriefEnvelope {
  readonly date: string;
  readonly window: { readonly since: string; readonly until: string };
  readonly eventsByKind: Readonly<Partial<Record<BrainLogEventKind, number>>>;
  readonly statusTransitions: ReadonlyArray<PeriodStatusTransition>;
  readonly vaultDelta: PeriodVaultDelta;
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
  // `_vault` is part of the helper signature for parity with sibling
  // projections; the brief itself is a pure projection over the index
  // and does not re-touch disk.
  const offsetHours = opts.offsetHours ?? 0;
  const window = dailyWindow(date, offsetHours);
  const generatedAt = (opts.now ?? new Date()).toISOString();

  const dayEvents = selectEvents(index, {
    since: window.since,
    until: window.until,
  });

  const transitions = collectTransitions(dayEvents);
  const vaultDelta = computeVaultDelta(dayEvents, transitions);

  return Object.freeze({
    date,
    window,
    eventsByKind: Object.freeze(countByKind(dayEvents)),
    statusTransitions: Object.freeze(transitions),
    vaultDelta: Object.freeze(vaultDelta),
    sourcePointers: Object.freeze(collectSourcePointers(dayEvents)),
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
  // Use second-precision canonical UTC so the string compare in
  // `selectEvents` matches the shape of event timestamps emitted by
  // `appendLogEvent` (also second-precision). Mixing the
  // `Date.toISOString()` `.000Z` form would still work by accident
  // (lexical ordering of `Z` vs `.`) but is fragile.
  return Object.freeze({
    since: isoSecond(new Date(dayStartMs - offsetMs)),
    until: isoSecond(new Date(dayStartMs - offsetMs + ONE_DAY_MS)),
  });
}
