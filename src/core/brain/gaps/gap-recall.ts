/**
 * Gap-scoped recall: the {@link GapRecallRetriever} the auto-close gate
 * runs against a real vault (theme A, t_67d38036).
 *
 * The gate hands the retriever the membership rule the answer will be
 * judged by, and refuses by name any answer that contains a row the rule
 * excludes. A plain {@link defaultRecallRetriever} is structurally
 * assignable to that type - TypeScript accepts a one-parameter function
 * where a two-parameter one is wanted - but it ignores the predicate, so
 * it returns the gap-task note itself and the gate throws. This module is
 * the retriever that actually honours the rule.
 *
 * ## Why the coverage is recomputed rather than reused
 *
 * `SearchOutcome.idfWeightedCoverage` is measured over the rows the search
 * returned. Drop a row and reuse that number and the gate reads a match
 * quality that includes the very row the membership rule exists to
 * exclude - a gap-task note carries its own topic verbatim, so it is
 * usually the strongest row in the set, and the floor would clear on the
 * task's own text. So the number is rebuilt over exactly the rows this
 * retriever returns, through {@link coverageOverResults}, on ONE path: the
 * quantity always describes the returned rows, whether or not anything was
 * dropped, so the two cases cannot drift apart.
 *
 * ## Why not shape the retrieval instead
 *
 * The tempting alternative is to make the excluded rows unreachable by the
 * query, so the search's own coverage is already over admitted rows only,
 * and `resolveSearchConfig` does accept `scopeRules`. It was rejected on
 * the facts: `ResolvedSearchConfig.scopeRules` is read in exactly one
 * place, `walkVaultScope` in `src/core/search/walker.ts`, which is the
 * INDEXER's walk. Query time never consults it. Passing exclusion rules
 * here would therefore (a) change nothing for the normal case of an index
 * that already exists, and (b) when a self-heal did rebuild, write a
 * shared index with the gap tasks missing from it - breaking every other
 * search of the vault to serve this gate. `SearchOptions` has a positive
 * `pathPrefix` but no exclusion, so there is no query-time way to shape
 * the row set. Recomputation is the only honest option available.
 *
 * The third option - reporting `null` coverage whenever a row was dropped
 * - is not implemented anywhere here on purpose: a gap task matches its
 * own topic almost every time, so "unmeasurable whenever something was
 * dropped" would be "unmeasurable always", and auto-close would be a
 * feature that never fires while looking like one that works.
 */

import { resolve } from "node:path";

import { searchAcrossVaults } from "../../search/cross-vault.ts";
import { coverageOverResults } from "../../search/evidence-verification.ts";
import { resolveSearchConfig } from "../../search/index.ts";
import { Store } from "../../search/store.ts";
import type { BrainSearchResult, ResolvedSearchConfig } from "../../search/types.ts";
import type { RecallCandidate } from "../recall-inject.ts";
import type { GapRecallRetriever } from "./gap-loop.ts";

/** Admitted rows one gap recall reports; the gate only needs a handful. */
export const GAP_RECALL_MAX_ROWS = 4;

/**
 * How many rows are fetched per admitted row wanted.
 *
 * The exclusion happens after ranking (see above: there is no query-time
 * way to shape it), so every excluded row occupies a slot the admitted
 * rows needed. Without over-fetch a vault holding several gap tasks whose
 * topics overlap could fill the whole window with notes the gate rejects
 * and report "nothing covers this" over a vault that covers it well.
 */
export const GAP_RECALL_OVERFETCH = 4;

/**
 * A retriever for {@link autoCloseRecalledGaps} that answers strictly
 * inside the membership rule it is handed: the rows it returns are
 * admitted rows, and its `idfWeightedCoverage` measures those same rows.
 *
 * Coverage is weighed against the ACTIVE vault's corpus statistics, which
 * is the corpus the gap task itself belongs to. The union may surface rows
 * from read-only recall sources; `searchAcrossVaults` already folds
 * per-origin coverages measured on per-origin corpora, so one IDF scale
 * for the merged window is if anything the more coherent number.
 *
 * A coverage that cannot be measured at all - the index will not open, or
 * the topic carries no IDF mass - is reported as `null`, which keeps the
 * task open. That is the fail-safe the gate documents, and it is reached
 * only by an unmeasurable retrieval, never by the ordinary act of dropping
 * a row.
 */
export function gapScopedRecallRetriever(
  configPath: string,
  vault: string,
  limit: number = GAP_RECALL_MAX_ROWS,
): GapRecallRetriever {
  const activeVault = resolve(vault);
  return async (topic, admits) => {
    const config = resolveSearchConfig({ vault: activeVault, configPath });
    const outcome = await searchAcrossVaults(
      configPath,
      activeVault,
      { query: topic, limit: Math.max(1, limit) * GAP_RECALL_OVERFETCH },
      config,
    );
    const admitted = outcome.results
      .filter((result) => admits(result.path))
      .slice(0, Math.max(1, limit));
    return Object.freeze({
      candidates: Object.freeze(admitted.map(toRecallCandidate)),
      total: outcome.total,
      idfWeightedCoverage: await coverageOverAdmitted(config, topic, admitted),
    });
  };
}

function toRecallCandidate(result: BrainSearchResult): RecallCandidate {
  return Object.freeze({
    path: result.path,
    title: result.title,
    score: result.score,
    searchType: result.searchType,
    startLine: result.startLine,
    endLine: result.endLine,
    ...(result.origin !== undefined ? { origin: result.origin } : {}),
  });
}

/**
 * IDF-weighted coverage of `query` over exactly `results`, or `null` when
 * the corpus cannot be read. The store is opened read-only (and without
 * the vector extension, which coverage does not use) for the length of one
 * document-frequency read, mirroring every other read-side store user.
 */
async function coverageOverAdmitted(
  config: ResolvedSearchConfig,
  query: string,
  results: ReadonlyArray<BrainSearchResult>,
): Promise<number | null> {
  let store: Store;
  try {
    store = await Store.open(config, { mode: "read", loadVec: false });
  } catch {
    return null;
  }
  try {
    return coverageOverResults(store, query, results).idfWeightedCoverage;
  } catch {
    return null;
  } finally {
    await store.close();
  }
}
