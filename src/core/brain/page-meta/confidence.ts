/**
 * Per-page confidence axis - generalises the existing
 * `BRAIN_CONFIDENCE` triple (`high`, `medium`, `low`) so it can also
 * appear on non-preference pages (signals, evidence drafts, retired
 * snapshots). The preference writer still owns the dream-computed
 * `_confidence_value` numeric; this module deals only with the
 * textual bucket and the reader-side default.
 */

import { BRAIN_CONFIDENCE, type BrainConfidence } from "../types.ts";

export type PageConfidence = BrainConfidence;

const ALL: ReadonlySet<string> = new Set(Object.values(BRAIN_CONFIDENCE));

export function isPageConfidence(value: unknown): value is PageConfidence {
  return typeof value === "string" && ALL.has(value);
}

/**
 * Read `_confidence` (or legacy `confidence`) from a frontmatter map.
 * Unknown / absent values fall back to `low` so a page that has not
 * yet earned a confidence stamp does not get one for free.
 */
export function readConfidence(
  meta: Readonly<Record<string, unknown>>,
): PageConfidence {
  const modern = meta["_confidence"];
  if (isPageConfidence(modern)) return modern;
  const legacy = meta["confidence"];
  if (isPageConfidence(legacy)) return legacy;
  return BRAIN_CONFIDENCE.low;
}

export { BRAIN_CONFIDENCE };
