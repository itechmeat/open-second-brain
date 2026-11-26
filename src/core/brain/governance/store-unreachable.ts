/**
 * What of the brain store a read on a switched machine could not reach,
 * so a forget (the plan and the confirmed `delete_by_source`) says what
 * it could not see instead of answering "nothing more to remove" for
 * records it never read. Both folds a forget traces through stream the
 * store's `events`: the memory records (signals, preferences) and the
 * lane entries, so the answer is the union of what each skipped. Below
 * local reach only the gaps of `shared` are named: private-partition lane
 * entries are withheld below local reach, and so are the `private` shards.
 */
import { privateWithheld } from "../../store/caller-reach.ts";
import { laneFoldIncomplete, laneStoreFold } from "../../store/lane-fold-cache.ts";
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
    // The memory fold reads every partition whatever the scope: below local
    // reach a `private` shard it could not read is not named either.
    const withheld = privateWithheld();
    for (const rel of entities.unreadable) {
      if (!withheld || !rel.startsWith("private/")) out.add(rel);
    }
    // A body still on its way is reported from the caller's partitions
    // only: below local reach a pending body of `private` is not named.
    const skipped = withheld
      ? entities.pendingBlobs.some((blob) => !blob.startsWith("private/"))
      : entities.skippedPending;
    if (skipped) pending = true;
  }
  // The caller's fold, for the verdict and the names alike: below local
  // reach it holds `shared` only, so a `private` gap is neither reported
  // nor named there.
  const lane = laneStoreFold();
  if (laneFoldIncomplete(lane)) {
    for (const rel of lane.unreadable) out.add(rel);
    if (lane.unreadable.length === 0) pending = true;
  }
  const named = [...out].toSorted();
  return pending ? [...named, STORE_PENDING_BODY] : named;
}
