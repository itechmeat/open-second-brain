/**
 * The one privacy verdict of a multi-page entity write (an entity merge, a
 * label prune): private when any page it touches is private or names a
 * private page, so every record of the write lands in one partition
 * (design D14, the phase 1 rule of one verdict per operation). Judged from
 * the pages as they read before the write; a page that cannot be read or
 * judged counts as private, the partition that leaks nothing. A page the
 * store holds in `private` is private even when no field or region says
 * so (it was written inside a private operation): the write keeps the
 * strictest partition of every entry it replaces or folds in.
 */

import { opaqueFields } from "../../store/operation-privacy.ts";
import { isPrivateFrontmatter } from "../../store/private-page.ts";
import { rowNamesPrivatePage } from "../../store/reference-privacy.ts";
import { laneEntryInPrivate, parseLanePage } from "../../store/lane-pages.ts";

/** Fields of an entity page that name no page: its own coordinates and stamps. */
const ENTITY_PAGE_OPAQUE_FIELDS = opaqueFields("category", "status", "created_at", "updated_at");

/** Whether any of the entity pages at `paths` is private or names a private page. */
export function entityPagesPrivate(vault: string, paths: ReadonlyArray<string>): boolean {
  try {
    return paths.some((path) => {
      if (laneEntryInPrivate(vault, path)) return true;
      const [meta, body] = parseLanePage(vault, path);
      return (
        isPrivateFrontmatter(meta) ||
        rowNamesPrivatePage(vault, { fields: meta, text: body }, ENTITY_PAGE_OPAQUE_FIELDS)
      );
    });
  } catch {
    return true;
  }
}
