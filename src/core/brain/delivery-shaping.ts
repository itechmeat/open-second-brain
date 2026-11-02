/**
 * Delivery shaping: the treatment a stored record's text gets when an
 * MCP read hands it to a caller (delivery-trust wave, lane A).
 *
 * The vault records rich provenance about its own content - which
 * process wrote a record (`origin_channel`), what kind of material it
 * carries (`content_class`), whether it entered under untrusted
 * provenance (the `untrusted_source` marker) - and none of that was
 * visible at the point of consumption: a remote agent reading a stored
 * record received agent-written text in the same voice as
 * operator-written text. This module is the vocabulary the read faces
 * use to close that gap, and the one shaper they all call.
 *
 * Two treatments, and the pair is closed on purpose:
 *
 *   - `plain`  - the operator's own bytes, returned unchanged. One
 *     answer earns it: a page stamped `origin_channel: cli` with no
 *     other marker. Everything else fails closed (see
 *     `provenance/page-origin.ts` for the derivation).
 *   - `fenced` - the text wrapped in the SAME `<untrusted_source>`
 *     aggregate fence the intake path uses
 *     (`fenceUntrustedContent`), so a downstream model treats a
 *     delivery-fenced span exactly as it already treats an
 *     intake-fenced span: same tag, same body neutralization, no new
 *     delimiter vocabulary to learn and no second convention to drift
 *     away from the first.
 *
 * Read-time only: like the whole fence family, shaping never rewrites
 * the page on disk. The fence lives in the delivered bytes - the text
 * replaces itself inside the field it was read from - so no output
 * schema grows a marker field and no parked artifact copy is left
 * unfenced, provided callers shape BEFORE results are built.
 */

import { fenceUntrustedContent, neutralizeSingleLine } from "./untrusted-source.ts";

/**
 * The closed treatment vocabulary. Two members because there are
 * exactly two things a delivery can do with stored text it is about to
 * hand over: pass it through, or fence it. The values are delivered in
 * the shaped result so a caller can branch on what happened without
 * re-deriving it, and the frozen object is the census-registered
 * vocabulary (`tests/core/architecture/verdict-vocabulary-census.test.ts`).
 */
export const DELIVERY_TREATMENT = Object.freeze({
  plain: "plain",
  fenced: "fenced",
} as const);

export type DeliveryTreatment = (typeof DELIVERY_TREATMENT)[keyof typeof DELIVERY_TREATMENT];

/**
 * The membership list, exported so the census trio is complete and a
 * refusal can name the vocabulary instead of restating it - the same
 * rule `ORIGIN_CHANNELS` follows.
 */
export const DELIVERY_TREATMENTS: ReadonlyArray<DeliveryTreatment> = Object.freeze(
  Object.values(DELIVERY_TREATMENT),
);

/** Takes `unknown`: a treatment can arrive from a persisted payload. */
export function isDeliveryTreatment(value: unknown): value is DeliveryTreatment {
  return (
    typeof value === "string" && (DELIVERY_TREATMENTS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * What one stored record's text looks like on delivery: the bytes and
 * the treatment they received. `treatment` is stated beside the text so
 * a caller that needs to know (a telemetry lane, a test) never has to
 * sniff for fence tags to find out.
 */
export interface DeliveredStoredText {
  readonly text: string;
  readonly treatment: DeliveryTreatment;
}

/**
 * Shape one stored record's text for delivery.
 *
 * `plain` returns the input bytes unchanged - the same string, no
 * re-render, so a local-reach caller (byte-identical contract) and a
 * proven-stamped operator page cannot drift from the pre-shaping wire
 * shape. `fenced` runs the text through `fenceUntrustedContent` with the
 * caller's origin label: the body is the neutralizer's output (control,
 * bidi and zero-width characters stripped; this module's own delimiter
 * escaped wherever it appears in the content), so embedded content can
 * neither close the fence early nor forge a second provenance frame,
 * and the result is idempotent under a second application.
 *
 * The origin label is hygiene-checked before it reaches the fence:
 * neutralized and collapsed to one line exactly as the light framing
 * headers treat their own label, then attribute-escaped by the fence
 * itself. `fenceUntrustedContent` escapes quotes and angle brackets but
 * passes newlines through, so a label is the one input here a hostile
 * caller could use to break the fence's single-line open tag - and the
 * delivery faces derive labels from closed stamp vocabularies anyway.
 * This is the belt to that suspenders.
 */
export function shapeStoredTextForDelivery(
  text: string,
  opts: { treatment: DeliveryTreatment; origin: string },
): DeliveredStoredText {
  if (opts.treatment === DELIVERY_TREATMENT.plain) {
    return { text, treatment: DELIVERY_TREATMENT.plain };
  }
  const label = neutralizeSingleLine(opts.origin).trim();
  return {
    text: fenceUntrustedContent(text, label),
    treatment: DELIVERY_TREATMENT.fenced,
  };
}
