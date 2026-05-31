import type { KeywordHit, Store } from "./store.ts";
import { SearchError } from "./types.ts";

export interface SafeKeywordOutcome {
  readonly hits: KeywordHit[];
  readonly warnings: ReadonlyArray<string>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRebuildableFtsError(e: unknown): boolean {
  const msg = errorMessage(e);
  return /SQLITE_CORRUPT|database disk image is malformed|malformed|corrupt/i.test(msg);
}

function ftsEmptyWhileChunksExist(store: Store): boolean {
  const counts = store.ftsIntegrityCounts();
  return counts.chunks > 0 && counts.ftsRows === 0;
}

function rebuildWarning(cause: string): string {
  return `rebuilt FTS index after ${cause}; retried keyword search`;
}

export function keywordTopKWithFtsSafety(
  store: Store,
  fts5Query: string,
  opts: { readonly limit: number; readonly pathPrefix?: string | null },
): SafeKeywordOutcome {
  try {
    const hits = store.keywordTopK(fts5Query, opts);
    if (hits.length > 0 || !ftsEmptyWhileChunksExist(store)) {
      return Object.freeze({ hits, warnings: Object.freeze([]) });
    }

    store.rebuildFtsIndexWithWriterLock();
    return Object.freeze({
      hits: store.keywordTopK(fts5Query, opts),
      warnings: Object.freeze([rebuildWarning("empty chunk_fts with indexed chunks")]),
    });
  } catch (e) {
    if (!isRebuildableFtsError(e)) throw e;
    try {
      store.rebuildFtsIndexWithWriterLock();
      return Object.freeze({
        hits: store.keywordTopK(fts5Query, opts),
        warnings: Object.freeze([rebuildWarning("rebuildable FTS error")]),
      });
    } catch (retryError) {
      throw new SearchError(
        "INDEX_UNREADABLE",
        `keyword FTS rebuild/retry failed: ${errorMessage(retryError)}`,
      );
    }
  }
}
