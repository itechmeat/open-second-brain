/**
 * The id a create of a batch takes when an earlier create of the same
 * batch takes the free id it was predicted (change
 * `lane-private-partition-reach`, the write rule).
 *
 * Each item's free id is predicted against the store as it stands, so two
 * new entities of one batch whose names share a slug are both predicted
 * the base id; the batch's writes give the second the next suffix free on
 * the fold of every partition. The prediction does the same, so the staged
 * review entries a batch would meet are judged for the ids it takes.
 */

import { lanePageExists } from "../../store/lane-pages.ts";
import { takenOnWholeFold } from "../../store/lane-reach-guard.ts";

/** `predicted`, or its next `-<n>` suffix that neither `allocated` nor the store holds. */
export function nextUnallocatedPath(
  vault: string,
  predicted: string,
  allocated: ReadonlyArray<string>,
): string {
  if (!allocated.includes(predicted)) return predicted;
  const stem = predicted.replace(/\.md$/u, "");
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}.md`;
    if (allocated.includes(candidate)) continue;
    if (takenOnWholeFold(() => lanePageExists(vault, candidate))) continue;
    return candidate;
  }
}
