/**
 * Read-open policy for the query hot path: how a stale, absent, or
 * unreadable index heals itself instead of failing the search.
 */

import { Store } from "../store.ts";
import { SearchError } from "../types.ts";
import type { ResolvedSearchConfig, SearchErrorCode } from "../types.ts";

/**
 * The open failures a rebuild can actually repair: a stale schema, an
 * absent index, and an index that is present but unreadable - which now
 * includes one condemned by the structural integrity gate.
 */
const SELF_HEALABLE_CODES: ReadonlySet<SearchErrorCode> = new Set<SearchErrorCode>([
  "INDEX_MISSING",
  "SCHEMA_MISMATCH",
  "INDEX_UNREADABLE",
]);

/**
 * Open the index for reading, self-healing a stale, absent, or unreadable
 * index. After a plugin upgrade the on-disk index can be a different schema
 * version (`SCHEMA_MISMATCH`), not yet built (`INDEX_MISSING`), or corrupt
 * / truncated / non-OSB at the index path (`INDEX_UNREADABLE`); rather than
 * forcing the user to run `o2b search reindex` / `o2b search index`, rebuild
 * once and retry. `reindexVault` is imported lazily so the hot path never
 * pulls in the indexer and there is no module cycle.
 *
 * A rebuild that fails is not swallowed. It may legitimately be a
 * concurrent writer already rebuilding (`INDEX_LOCKED`), in which case the
 * retry below succeeds and there is nothing to report - so its failure is
 * held rather than thrown. But if the retry ALSO fails, the retry's error
 * describes the symptom while the held one describes why the repair did not
 * happen, and a caller shown only the symptom would be sent back to the
 * command that just failed. Both are reported.
 */
export async function openReadOrSelfHeal(config: ResolvedSearchConfig): Promise<Store> {
  let openFailure: SearchError;
  try {
    return await Store.open(config, { mode: "read" });
  } catch (e) {
    if (!(e instanceof SearchError) || !SELF_HEALABLE_CODES.has(e.code)) throw e;
    openFailure = e;
  }

  let healFailure: string | null = null;
  try {
    const { reindexVault } = await import("../indexer.ts");
    await reindexVault(config);
  } catch (e) {
    healFailure = e instanceof Error ? e.message : String(e);
  }

  try {
    return await Store.open(config, { mode: "read" });
  } catch (e) {
    if (healFailure === null) throw e;
    const code: SearchErrorCode = e instanceof SearchError ? e.code : "INDEX_UNREADABLE";
    const symptom = e instanceof Error ? e.message : String(e);
    throw new SearchError(
      code,
      `${symptom} (the automatic rebuild of ${config.dbPath} after ` +
        `${openFailure.code} also failed: ${healFailure})`,
    );
  }
}
