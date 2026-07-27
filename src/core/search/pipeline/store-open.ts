/**
 * Read-open policy for the query hot path: how a stale, absent, or
 * unreadable index heals itself instead of failing the search.
 */

import { Store } from "../store.ts";
import { SearchError } from "../types.ts";
import type { ResolvedSearchConfig } from "../types.ts";

/**
 * Open the index for reading, self-healing a stale, absent, or unreadable
 * index. After a plugin upgrade the on-disk index can be a different schema
 * version (`SCHEMA_MISMATCH`), not yet built (`INDEX_MISSING`), or corrupt
 * / truncated / non-OSB at the index path (`INDEX_UNREADABLE`); rather than
 * forcing the user to run `o2b search reindex` / `o2b search index`, rebuild
 * once and retry. `reindexVault` is imported lazily so the hot path never
 * pulls in the indexer and there is no module cycle.
 */
export async function openReadOrSelfHeal(config: ResolvedSearchConfig): Promise<Store> {
  try {
    return await Store.open(config, { mode: "read" });
  } catch (e) {
    if (
      e instanceof SearchError &&
      (e.code === "INDEX_MISSING" || e.code === "SCHEMA_MISMATCH" || e.code === "INDEX_UNREADABLE")
    ) {
      try {
        const { reindexVault } = await import("../indexer.ts");
        await reindexVault(config);
      } catch {
        // A concurrent writer may already be rebuilding (INDEX_LOCKED), or the
        // rebuild failed - fall through and let the retry surface real state.
      }
      return await Store.open(config, { mode: "read" });
    }
    throw e;
  }
}
