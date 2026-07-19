/**
 * Shared session-start activity rendering helper (theme A, t_4adb0b8b).
 *
 * A small pure helper that turns a heterogeneous set of session-start
 * items (a confirmed preference, an open question, a narrative note) into
 * a typed, age-labeled, chronological timeline. Two concerns and only
 * two: a FIXED structural marker per item kind, and a relative-age label
 * derived from the item's stored timestamp. There is deliberately no
 * natural-language classification here - the marker comes from the item
 * kind, never from the item's words - so the timeline stays language
 * agnostic.
 *
 * Kept free of vault and I/O concerns so it is trivially unit-testable
 * and reusable by every theme-A surface (the morning brief now; the
 * knowledge-gap agenda later) without a shared fail-open/fail-closed
 * guarantee leaking between them.
 */

import { relativeAge } from "../time.ts";

/**
 * Fixed structural marker vocabulary. The key is the item kind; the value
 * is the short marker stamped into the rendered line. Config-free and
 * closed - a new kind is a code change, never a runtime string.
 */
export const ACTIVITY_MARKER = {
  preference: "pref",
  openQuestion: "open",
  note: "note",
} as const;

export type ActivityKind = keyof typeof ACTIVITY_MARKER;

/** One timeline item: its kind, display text, and stored ISO timestamp. */
export interface ActivityItem {
  readonly kind: ActivityKind;
  readonly text: string;
  /** Stored ISO timestamp; drives the age label. Empty/unparseable = no age. */
  readonly timestamp: string;
}

/** The fixed structural marker for an item kind. */
export function activityMarker(kind: ActivityKind): string {
  return ACTIVITY_MARKER[kind];
}

/**
 * Render one activity line as a Markdown bullet: `- [marker] text · age`.
 * The age is omitted (no trailing `· `) when the timestamp is empty or
 * unparseable, matching {@link relativeAge}'s empty-string contract.
 */
export function renderActivityLine(item: ActivityItem, now: Date): string {
  const age = relativeAge(item.timestamp, now);
  return `- [${ACTIVITY_MARKER[item.kind]}] ${item.text}${age ? ` · ${age}` : ""}`;
}

/** Sort key: parsed epoch ms, or NaN for an empty/unparseable timestamp. */
function instantMs(item: ActivityItem): number {
  return Date.parse(item.timestamp);
}

/** Marker order index, for a deterministic tie-break between equal instants. */
function markerOrder(kind: ActivityKind): number {
  return Object.keys(ACTIVITY_MARKER).indexOf(kind);
}

/**
 * Render an ordered, most-recent-first chronological timeline. Items with
 * an unparseable/empty timestamp carry no position and sort last. Ties
 * break by marker order then text so the output is deterministic. Returns
 * the empty string for no items. Pure - does not mutate the input.
 */
export function renderActivityTimeline(items: ReadonlyArray<ActivityItem>, now: Date): string {
  const ordered = items.toSorted((a, b) => {
    const am = instantMs(a);
    const bm = instantMs(b);
    const aDated = !Number.isNaN(am);
    const bDated = !Number.isNaN(bm);
    if (aDated !== bDated) return aDated ? -1 : 1; // dated items first
    if (aDated && bDated && am !== bm) return bm - am; // most recent first
    const mo = markerOrder(a.kind) - markerOrder(b.kind);
    if (mo !== 0) return mo;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });
  return ordered.map((item) => renderActivityLine(item, now)).join("\n");
}
