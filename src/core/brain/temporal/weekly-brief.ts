/**
 * `buildWeeklySynthesis(index, vault, weekEnd, cfg, opts?)` - 7-day
 * deterministic summary used by the weekly-synthesis surface.
 *
 * Shape mirrors `buildDailyBrief` but the window is 7 days back from
 * `weekEnd` (ISO date). On top of the daily envelope the weekly
 * synthesis adds:
 *
 *   - `retired`: list of retire transitions inside the window.
 *   - `contradictions`: combined list of `signal-suppressed` events
 *     plus `apply-evidence` events where the payload `result` is
 *     `"violated"`. Both surfaces signal a clash between the agent's
 *     stated rule and the underlying activity.
 *
 * Design anchor: `docs/brainstorm/temporal-synthesis/design.md`,
 * Task 7 in `plan.md`.
 */

import { isoSecond } from "./../time.ts";
import type { BrainLogEventKind, ResolvedBrainTemporalConfig } from "./../types.ts";
import { BRAIN_LOG_EVENT_KIND } from "./../types.ts";
import { selectEvents } from "./select-events.ts";
import {
  collectSourcePointers,
  collectTransitions,
  computeVaultDelta,
  countByKind,
  type PeriodStatusTransition,
  type PeriodVaultDelta,
} from "./period-common.ts";
import type { TemporalEvent, TimelineIndex } from "./types.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface WeeklyContradiction {
  readonly at: string;
  readonly kind: "signal-suppressed" | "evidence-violated";
  readonly prefId?: string;
  readonly topic?: string;
  readonly reason?: string;
  readonly artifact?: string;
}

export interface WeeklyRetirement {
  readonly at: string;
  readonly prefId: string;
  readonly link: string;
}

export interface WeeklySynthesisEnvelope {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly eventsByKind: Readonly<Partial<Record<BrainLogEventKind, number>>>;
  readonly statusTransitions: ReadonlyArray<PeriodStatusTransition>;
  readonly retired: ReadonlyArray<WeeklyRetirement>;
  readonly contradictions: ReadonlyArray<WeeklyContradiction>;
  readonly vaultDelta: PeriodVaultDelta;
  readonly sourcePointers: ReadonlyArray<string>;
  readonly generatedAt: string;
}

export interface BuildWeeklySynthesisOptions {
  /** Wall clock for `generatedAt`; defaults to `new Date()`. */
  readonly now?: Date;
}

export function buildWeeklySynthesis(
  index: TimelineIndex,
  _vault: string,
  weekEnd: string,
  _cfg: ResolvedBrainTemporalConfig,
  opts: BuildWeeklySynthesisOptions = {},
): WeeklySynthesisEnvelope {
  // `_vault` / `_cfg` are part of the helper signature for parity
  // with sibling projections and forward compatibility (weekday-
  // alignment overrides will read `_cfg.weekly_start_dow` in a
  // future release); the brief itself is a pure projection over the
  // index and does not re-touch disk.
  const windowEndMs = Date.parse(`${weekEnd}T00:00:00Z`);
  if (!Number.isFinite(windowEndMs)) {
    throw new Error(`buildWeeklySynthesis: invalid weekEnd ${JSON.stringify(weekEnd)}`);
  }
  const windowStartMs = windowEndMs - 7 * ONE_DAY_MS;
  const windowStart = isoSecond(new Date(windowStartMs));
  const windowEndIso = isoSecond(new Date(windowEndMs));
  const generatedAt = (opts.now ?? new Date()).toISOString();

  const events = selectEvents(index, {
    since: windowStart,
    until: windowEndIso,
  });

  const transitions = collectTransitions(events);
  const vaultDelta = computeVaultDelta(events, transitions);
  const retired = transitions
    .filter((t) => t.kind === "retirement")
    .map((t) => Object.freeze({ at: t.at, prefId: t.prefId, link: t.link }));
  const contradictions = collectContradictions(events);

  return Object.freeze({
    windowStart,
    windowEnd: windowEndIso,
    eventsByKind: Object.freeze(countByKind(events)),
    statusTransitions: Object.freeze(transitions),
    retired: Object.freeze(retired),
    contradictions: Object.freeze(contradictions),
    vaultDelta: Object.freeze(vaultDelta),
    sourcePointers: Object.freeze(collectSourcePointers(events)),
    generatedAt,
  });
}

function collectContradictions(events: ReadonlyArray<TemporalEvent>): WeeklyContradiction[] {
  const out: WeeklyContradiction[] = [];
  for (const ev of events) {
    if (ev.kind === BRAIN_LOG_EVENT_KIND.signalSuppressed) {
      out.push(makeContradiction("signal-suppressed", ev));
    } else if (ev.kind === BRAIN_LOG_EVENT_KIND.applyEvidence && ev.result === "violated") {
      out.push(makeContradiction("evidence-violated", ev));
    }
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

function makeContradiction(
  kind: WeeklyContradiction["kind"],
  ev: TemporalEvent,
): WeeklyContradiction {
  return Object.freeze({
    at: ev.at,
    kind,
    ...(ev.prefId !== undefined ? { prefId: ev.prefId } : {}),
    ...(ev.topic !== undefined ? { topic: ev.topic } : {}),
    ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
    ...(ev.artifact !== undefined ? { artifact: ev.artifact } : {}),
  });
}
