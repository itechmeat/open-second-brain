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
import type { FrontmatterCache } from "../../core/search/result-filters.ts";
import {
  deliveryOriginLabel,
  pageOriginForDelivery,
  storedTextTreatment,
} from "../../core/brain/provenance/page-origin.ts";
import { shapeStoredTextForDelivery } from "../../core/brain/delivery-shaping.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../core/graph/transport-reach.ts";
import type { TemporalEvent } from "../../core/brain/temporal/types.ts";
import type { ServerContext } from "../tool-contract.ts";
import { contextReach } from "../tool-contract.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";

export { eventAtReach, recordRefs };

/**
 * The reference view for one request: unfiltered at local reach with the
 * ownership gate off, the request's reach and owner predicate otherwise.
 */
export function requestRefView(ctx: ServerContext): ArtifactRefView {
  return readerRefView(ctx.vault, readableAtContextReachOrUndefined(ctx));
}

/**
 * The delivery binding for one report-shaped request (delivery-trust,
 * lane A): the one object every report-shaped read shares for shaping
 * stored record text on its way out.
 *
 * It answers the request's reach once - `reach`, for callers that need
 * to branch before shaping at all - and `shape(text, rel)` for the
 * bodies themselves. At local reach `shape` is the identity and the
 * binding holds no state: the operator's own tools get the pre-wave
 * bytes, and no shaper code runs at all. At remote reach each body is
 * probed through ONE `FrontmatterCache` per request - one frontmatter
 * read per distinct page however many serializers name it - and
 * delivered through the K1 shaper: fenced unless the page proves
 * operator-authorship, fail-closed to fenced on every absence, with the
 * fence's origin attribute naming the derived provenance.
 *
 * The fence lives inside the field the text was read from, so no output
 * schema changes; a reference the request's view withholds never
 * reaches a serializer (a fence on a withheld row would be an existence
 * leak), and the log-entry serializers are deliberately NOT wired
 * through this binding - their formats are parsed by heading structure
 * and stay the wave's stated delivery-shaping boundary.
 */
export function deliveryView(
  ctx: ServerContext,
  opts?: { cache?: FrontmatterCache },
): {
  reach: TransportReach;
  shape(text: string, rel: string): string;
} {
  const reach = contextReach(ctx);
  if (reach === TRANSPORT_REACH.local) return { reach, shape: (text) => text };
  const cache: FrontmatterCache = opts?.cache ?? new Map();
  return {
    reach,
    shape(text: string, rel: string): string {
      const origin = pageOriginForDelivery(ctx.vault, rel, cache);
      return shapeStoredTextForDelivery(text, {
        treatment: storedTextTreatment(origin),
        origin: deliveryOriginLabel(origin),
      }).text;
    },
  };
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
