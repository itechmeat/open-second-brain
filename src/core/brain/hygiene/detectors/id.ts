/**
 * Deterministic hygiene finding ids: `<detector>:<sha256 prefix>` over
 * the sorted target list, so the same finding keeps the same id across
 * scans and can be selected into an apply plan by id.
 */

import { createHash } from "node:crypto";

import type { HygieneDetectorId } from "../types.ts";

export function hygieneFindingId(
  detector: HygieneDetectorId,
  targets: ReadonlyArray<string>,
): string {
  const digest = createHash("sha256").update(targets.toSorted().join("\0")).digest("hex");
  return `${detector}:${digest.slice(0, 12)}`;
}
