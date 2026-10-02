/**
 * The Brain log event rule bound to one request.
 *
 * Every MCP reader that renders log events - the daily and weekly briefs,
 * the today view, and the timeline, belief-evolution and
 * concept-synthesis analytics views - asks the same question: which of
 * these events may this caller see, and in what form? The rule itself
 * lives in `core/brain/log-events-at-reach.ts`, where the core readers
 * (the digest, the event trace) reach it too; this module binds it to
 * the request's reach and owner predicate, so no reader rebuilds the
 * reference view by hand.
 */

import { readerRefView, type ArtifactRefView } from "../../core/brain/artifact-ref-view.ts";
import { eventAtReach, recordRefs } from "../../core/brain/log-events-at-reach.ts";
import type { TemporalEvent } from "../../core/brain/temporal/types.ts";
import type { ServerContext } from "../tool-contract.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";

export { eventAtReach, recordRefs };

/**
 * The reference view for one request: unfiltered at local reach with the
 * ownership gate off, the request's reach and owner predicate otherwise.
 */
export function requestRefView(ctx: ServerContext): ArtifactRefView {
  return readerRefView(ctx.vault, readableAtContextReachOrUndefined(ctx));
}

/** The events this caller may see, each in the form it may see it, in order. */
export function eventsAtReach(
  refs: ArtifactRefView,
  events: ReadonlyArray<TemporalEvent>,
): ReadonlyArray<TemporalEvent> {
  if (refs.filtersNothing) return events;
  return events.flatMap((ev) => eventAtReach(refs, ev) ?? []);
}

/**
 * May this caller read the record `id` names, under every spelling it
 * answers to? A record refused here is answered as an absent one.
 */
export function recordReadable(refs: ArtifactRefView, id: string): boolean {
  return refs.row(...recordRefs(id));
}
