/**
 * What of the brain store a read on a switched machine could not reach,
 * so a forget (the plan and the confirmed `delete_by_source`) says what
 * it could not see instead of answering "nothing more to remove" for
 * records it never read. Both folds a forget traces through stream the
 * store's `events`: the memory records (signals, preferences) and the
 * lane entries, so the answer is the union of what each skipped.
 */
import { foldIncomplete } from "../../store/lane-entry-store.ts";
import { laneStoreFold } from "../../store/lane-fold-cache.ts";
import { memoryEntities } from "../../store/read/memory-ids.ts";
import { memoryFromStore } from "../memory-pages.ts";

/** Named when a record was left out because its body has not arrived. */
export const STORE_PENDING_BODY = "a store record whose body has not arrived";

/** Named when the configured store could not be opened at all. */
export const STORE_UNOPENED = "the brain store (it could not be opened)";

/**
 * The `<partition>/<shard>` paths of the store's `events` that could not
 * be read, plus {@link STORE_PENDING_BODY} when a record was skipped for a
 * body still on its way; empty on an unswitched machine and on a store
 * read whole.
 */
export function storeUnreachable(vault: string): string[] {
  if (!memoryFromStore(vault)) return [];
  const out = new Set<string>();
  let pending = false;
  const entities = memoryEntities({ vault });
  if (entities === null) {
    out.add(STORE_UNOPENED);
  } else {
    for (const rel of entities.unreadable) out.add(rel);
    if (entities.skippedPending) pending = true;
  }
  if (foldIncomplete()) {
    const lane = laneStoreFold();
    for (const rel of lane.unreadable) out.add(rel);
    if (lane.unreadable.length === 0) pending = true;
  }
  const named = [...out].toSorted();
  return pending ? [...named, STORE_PENDING_BODY] : named;
}
