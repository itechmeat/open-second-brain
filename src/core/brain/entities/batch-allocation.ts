/**
 * The id a create of a batch takes when an earlier create of the same
 * batch takes the free id it was predicted (change
 * `lane-private-partition-reach`, the write rule).
 *
 * Each item's free id is predicted against the store as it stands, so two
 * new entities of one batch whose names share a slug are both predicted
 * the same free id; the batch's writes give the second the next suffix
 * free on the fold of every partition. The prediction walks the write's
 * own ladder (`allocateEntityId`): from the unsuffixed base id of the
 * entity's category and name, then `-2`, `-3`, and so on (change
 * `lane-reach-residuals`, design R8). The base comes from the category and
 * the name, never from a predicted path with a suffix stripped: a slug
 * that itself ends in `-2` keeps it in its base. So the staged review
 * entries a batch would meet are judged for the ids it takes.
 */

import { titleKeySlug } from "../../vault.ts";
import { lanePageExists } from "../../store/lane-pages.ts";
import { takenOnWholeFold } from "../../store/lane-reach-guard.ts";
import { BRAIN_ENTITY_ID_PREFIX } from "./types.ts";

/** The unsuffixed id a new entity of `category` and `name` starts its ladder from. */
export function entityBaseId(category: string, name: string): string {
  return `${BRAIN_ENTITY_ID_PREFIX}${category}-${titleKeySlug(name)}`;
}

/**
 * The first path of the write's ladder from `base` (the page path of the
 * unsuffixed base id), then its `-<n>` suffixes, that neither `allocated`
 * (the earlier creates of the batch) nor the store holds, read on the fold
 * of every partition.
 */
export function nextUnallocatedPath(
  vault: string,
  base: string,
  allocated: ReadonlyArray<string>,
): string {
  const stem = base.replace(/\.md$/u, "");
  const free = (candidate: string) =>
    !allocated.includes(candidate) && !takenOnWholeFold(() => lanePageExists(vault, candidate));
  if (free(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}.md`;
    if (free(candidate)) return candidate;
  }
}
