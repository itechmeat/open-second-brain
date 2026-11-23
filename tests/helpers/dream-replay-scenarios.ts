/**
 * Builders for the named equivalence scenarios of the dream replay
 * (task 1.2). A scenario is a history on the days of
 * `tests/helpers/dream-history.ts` (day 0 is 2026-04-01): every record has
 * an event time and an admission day, the day the daily driver makes it
 * visible. `compareReplay` runs it daily and as one replay.
 */

import type { WritePreferenceInput } from "../../src/core/brain/preference.ts";
import type { BrainRetiredReason } from "../../src/core/brain/types.ts";
import { dumpRows, type DumpRow, type HistoryEvent } from "./dream-history.ts";

const FIRST_DAY_MS = Date.parse("2026-04-01T00:00:00Z");
const DAY_MS = 86_400_000;

/** The ISO date of day `n`. */
export function dateOf(n: number): string {
  return new Date(FIRST_DAY_MS + n * DAY_MS).toISOString().slice(0, 10);
}

/** An instant on day `n`, at `hour` UTC. */
export function at(n: number, hour = 9): string {
  return `${dateOf(n)}T${String(hour).padStart(2, "0")}:00:00Z`;
}

export interface SignalSpec {
  readonly slug: string;
  readonly topic: string;
  /** Day and hour of the event. */
  readonly day: number;
  readonly hour?: number;
  /** Day the record reaches the machine; the event day by default. */
  readonly admitOn?: number;
  readonly sign?: "positive" | "negative";
  readonly agent?: string;
  readonly principle?: string;
  readonly expires?: string;
}

export function signal(spec: SignalSpec): HistoryEvent {
  const createdAt = at(spec.day, spec.hour ?? 9);
  return {
    kind: "signal",
    admitOn: spec.admitOn ?? spec.day,
    eventAt: createdAt,
    input: {
      topic: spec.topic,
      signal: spec.sign ?? "positive",
      agent: spec.agent ?? "claude",
      principle: spec.principle ?? `Follow the rule of ${spec.topic}.`,
      created_at: createdAt,
      date: dateOf(spec.day),
      slug: spec.slug,
      scope: "coding",
      ...(spec.expires !== undefined ? { expiration_date: spec.expires } : {}),
    },
  };
}

export interface PreferenceSpec {
  readonly slug: string;
  readonly topic: string;
  readonly day: number;
  readonly admitOn?: number;
  readonly principle?: string;
  /** `unconfirmed` with a deadline makes a trial. */
  readonly status?: "confirmed" | "unconfirmed";
  readonly deadline?: string;
  readonly supersedes?: string;
}

export function preference(spec: PreferenceSpec): HistoryEvent {
  const createdAt = at(spec.day, 0);
  const trial = spec.status === "unconfirmed";
  const input: WritePreferenceInput = {
    slug: spec.slug,
    topic: spec.topic,
    principle: spec.principle ?? `Keep the rule of ${spec.topic}.`,
    created_at: createdAt,
    unconfirmed_until: spec.deadline ?? at(spec.day + 14, 0),
    status: trial ? "unconfirmed" : "confirmed",
    confirmed_at: trial ? null : createdAt,
    evidenced_by: [],
    scope: "coding",
    ...(spec.supersedes !== undefined ? { supersedes: spec.supersedes } : {}),
  };
  return { kind: "preference", admitOn: spec.admitOn ?? spec.day, eventAt: createdAt, input };
}

export function retire(
  slug: string,
  day: number,
  reason: BrainRetiredReason,
  admitOn = day,
): HistoryEvent {
  return { kind: "retire", admitOn, eventAt: at(day, 6), input: { slug, reason } };
}

export function evidence(
  slug: string,
  day: number,
  options: { readonly hour?: number; readonly admitOn?: number; readonly device?: string } = {},
): HistoryEvent {
  return {
    kind: "evidence",
    ...(options.device !== undefined ? { device: options.device } : {}),
    admitOn: options.admitOn ?? day,
    eventAt: at(day, options.hour ?? 10),
    input: {
      pref_id: `pref-${slug}`,
      artifact: `Daily/${dateOf(day)}.md`,
      result: "applied",
      agent: "claude",
    },
  };
}

// ----- Reading a dump ----------------------------------------------------

function rowsOf(dump: string, kind: string): DumpRow[] {
  return dumpRows(dump).filter((row) => row.kind === kind);
}

/** The `preference-set` field values of preference `id`, merged in dump order. */
export function preferenceFields(dump: string, id: string): Record<string, unknown> | null {
  let fields: Record<string, unknown> | null = null;
  for (const row of rowsOf(dump, "preference-set")) {
    if (row.body["preference"] !== id) continue;
    fields = Object.assign({}, fields, row.body["fields"] as Record<string, unknown>);
  }
  return fields;
}

/** Ids of the preferences a dump holds a set for. */
export function preferenceIds(dump: string): string[] {
  return [
    ...new Set(rowsOf(dump, "preference-set").map((row) => String(row.body["preference"]))),
  ].toSorted();
}

/** The states the signal `slugStem` was moved to (`consumed`, `archived`). */
export function signalStates(dump: string, slugStem: string): string[] {
  const ids = new Set(
    rowsOf(dump, "signal")
      .map((row) => String(row.body["id"]))
      .filter((id) => new RegExp(`^sig-\\d{4}-\\d{2}-\\d{2}-${slugStem}-`).test(id)),
  );
  return rowsOf(dump, "signal-state")
    .filter((row) => ids.has(String(row.body["signal"])))
    .map((row) => String(row.body["state"]));
}

/** The audit events of a dump with `event_type`, their bodies. */
export function auditEvents(dump: string, eventType: string): Array<Record<string, unknown>> {
  return rowsOf(dump, "log-event")
    .filter((row) => row.body["event_type"] === eventType)
    .map((row) => row.body["body"] as Record<string, unknown>);
}

/** The rows of `kind` in a dump. */
export function dumpRowsOf(dump: string, kind: string): DumpRow[] {
  return rowsOf(dump, kind);
}
