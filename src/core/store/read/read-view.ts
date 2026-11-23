/**
 * The inputs of one dream window as a scoped read view (dream replay
 * design D3, "Inputs of a window").
 *
 * A window's inputs are the input records below its boundary (the
 * positions its admission record froze) whose effective time is not after
 * the window's instant. An input is a record of something that happened:
 * a signal's capture and an application of a rule, in both forms the
 * store has (the `apply-evidence` events of the log and the
 * `preference-evidence` records the preference fold counts). Everything
 * else is state (preferences and their updates, signal moves, retirements,
 * merges, settings) and is read as it is now, beyond the boundary too: it
 * is what earlier windows wrote, or what a person changed, which applies
 * from the first replayed window.
 *
 * While a view is active ({@link withStoreReadView}), the entity read
 * (`store-entities.ts`) and the store log read (`log-events.ts`) answer
 * with the view's records instead of the whole store, so every reader of
 * the pass sees the window's inputs without being handed them. The view
 * is the pass's own; nothing else runs inside it.
 */

import {
  LOG_EVENT_KIND,
  PREFERENCE_EVIDENCE_KIND,
  SIGNAL_KIND,
  type StorePartition,
} from "../constants.ts";
import type { StoreRecord } from "../envelope.ts";
import { parseHlc } from "../hlc.ts";
import type { ShardPosition } from "./shards-from.ts";

/** The log event type of an application of a rule (`brain/types.ts`). */
export const APPLY_EVIDENCE_EVENT = "apply-evidence";

/** Body field of a `preference-evidence` record: when the rule was applied. */
export const EVIDENCE_AT_FIELD = "at";

/** One window's view of the store. */
export interface StoreReadView {
  /** Distinct per window and admission: what a cache of a viewed read is keyed by. */
  readonly token: string;
  /** The window's boundary: per shard, the first byte not admitted. */
  readonly boundary: ReadonlyArray<ShardPosition>;
  /** The moment the window is judged at. */
  readonly instant: Date;
  /** Effective times the admission records gave (late and clamped records), by record id. */
  readonly effective: ReadonlyMap<string, string>;
}

let active: StoreReadView | null = null;

/** Run `fn` with `view` active. Views do not nest: an inner one replaces the outer one. */
export function withStoreReadView<T>(view: StoreReadView, fn: () => T): T {
  const outer = active;
  active = view;
  try {
    return fn();
  } finally {
    active = outer;
  }
}

/** The view a read inside a window answers with, or `null` outside one. */
export function activeStoreReadView(): StoreReadView | null {
  return active;
}

/** Whether `record` is an input of a window (a capture or an application). */
export function isInputRecord(record: StoreRecord): boolean {
  if (record.kind === SIGNAL_KIND || record.kind === PREFERENCE_EVIDENCE_KIND) return true;
  return record.kind === LOG_EVENT_KIND && record.body["event_type"] === APPLY_EVIDENCE_EVENT;
}

/**
 * When an input record says it happened: a signal's `created_at`, an
 * event's `timestamp`, an application's `at` (written since the replay;
 * an older record carries none, and its write clock stands in: an
 * application is recorded when it happens). `null` when it names none.
 */
export function eventTimeOf(record: StoreRecord): string | null {
  if (record.kind === SIGNAL_KIND) {
    const frontmatter = record.body["frontmatter"];
    const created =
      frontmatter !== null && typeof frontmatter === "object"
        ? (frontmatter as Record<string, unknown>)["created_at"]
        : undefined;
    return typeof created === "string" && Number.isFinite(Date.parse(created)) ? created : null;
  }
  if (record.kind === LOG_EVENT_KIND) {
    const timestamp = record.body["timestamp"];
    return typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))
      ? timestamp
      : null;
  }
  if (record.kind === PREFERENCE_EVIDENCE_KIND) {
    const at = record.body[EVIDENCE_AT_FIELD];
    if (typeof at === "string" && Number.isFinite(Date.parse(at))) return at;
    const clock = parseHlc(record.hlc);
    return clock === null ? null : new Date(clock.physical).toISOString();
  }
  return null;
}

/** The time a window judges an input record by: the admitted one, else its own. */
export function effectiveTimeOf(view: StoreReadView, record: StoreRecord): string | null {
  return view.effective.get(record.id) ?? eventTimeOf(record);
}

/**
 * Whether an input record below the boundary is visible in the view's
 * window: its effective time is not after the instant. A record that
 * names no time is visible (it cannot be placed later than the window).
 */
export function visibleInView(view: StoreReadView, record: StoreRecord): boolean {
  const at = effectiveTimeOf(view, record);
  return at === null || Date.parse(at) <= view.instant.getTime();
}

/** The boundary of one partition and stream folder, for a read with `until`. */
export function boundaryOf(
  view: StoreReadView,
  partition: StorePartition,
  stream: string,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const p of view.boundary) {
    if (p.partition === partition && p.stream === stream) out.set(p.shard, p.offset);
  }
  return out;
}
