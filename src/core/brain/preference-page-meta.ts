/**
 * A preference page's frontmatter rebuilt from the store's preference
 * fold (task 2.10). A leaf of the preference writer and parser
 * (`preference.ts`), so the readers that walk the fold's pages
 * (`memory-pages.ts`) reach it without importing the writer:
 *
 *  - {@link DERIVED_FIELDS}, the fields a page spells with a `_` prefix;
 *  - {@link storeEntryMeta}, the frontmatter the page of one fold entry
 *    would carry, typed as the legacy parser types it.
 */

import type { StorePreference } from "../store/read/store-entities.ts";
import type { FrontmatterMap } from "../types.ts";
import { formatFrontmatter, parseFrontmatterText } from "../vault.ts";
import { isRetiredEntry } from "./preference-store.ts";

/**
 * Group C — derived fields that get a `_` prefix in the on-disk
 * shape (dream-rewritten state, see §24). Parser accepts both
 * `name` and `_name`; writer always emits `_name`. Listed once so
 * both `parsePreference`, `parseRetired`, and the migration helper
 * share the same list — a follow-up adding a derived field updates
 * exactly this constant.
 */
export const DERIVED_FIELDS: ReadonlyArray<string> = Object.freeze([
  "status",
  "confirmed_at",
  "last_evidence_at",
  "applied_count",
  "violated_count",
  "confidence",
  "confidence_value",
  "evidenced_by",
  "contradicted_by",
  "lifecycle",
  "revision",
  "content_hash",
]);

const DERIVED_FIELD_SET: ReadonlySet<string> = new Set(DERIVED_FIELDS);

/**
 * `storePreferenceMeta` (`preference.ts`) for an entry the caller already holds, so a
 * reader walking every preference of the fold reads the store once.
 */
export function storeEntryMeta(
  entry: StorePreference,
  slug: string,
): { readonly meta: FrontmatterMap; readonly retired: boolean } {
  const retired = isRetiredEntry(entry);
  const meta: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entry.state.fields)) {
    // `text` is the page body, not frontmatter (see `textOfFields`).
    if (name === "kind" || name === "id" || name === "text") continue;
    if (DERIVED_FIELD_SET.has(name)) meta[`_${name}`] = value === null ? "null" : value;
    else if (value !== null) meta[name] = value;
  }
  meta["_applied_count"] = entry.state.counters.applied_count;
  meta["_violated_count"] = entry.state.counters.violated_count;
  meta["kind"] = retired ? "brain-retired" : "brain-preference";
  meta["id"] = `${retired ? "ret" : "pref"}-${slug}`;
  const [typed] = parseFrontmatterText(formatFrontmatter(meta as FrontmatterMap, ""));
  return { meta: typed, retired };
}
