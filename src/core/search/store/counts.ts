/**
 * The index census: one row-count per table the operator surfaces care
 * about, taken together so `o2b search status` reports a single
 * consistent picture rather than four independent probes.
 */

import { Database } from "bun:sqlite";

import { countChunks } from "./chunks.ts";
import { countDocuments } from "./documents.ts";
import { countEmbeddings, staleEmbeddings } from "./vectors.ts";
import { charLengthOverTokenBudget } from "../embeddings/signature.ts";

export interface StoreCounts {
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  /** Embeddings whose `model`/`dimension` no longer match the current config. */
  readonly staleEmbeddings: number;
}

export function counts(
  db: Database,
  configuredModel: string | null,
  configuredDimension: number | null,
): StoreCounts {
  return Object.freeze({
    documents: countDocuments(db),
    chunks: countChunks(db),
    embeddings: countEmbeddings(db),
    staleEmbeddings: staleEmbeddings(db, configuredModel, configuredDimension),
  });
}

/**
 * Chunks whose estimated embedding-request size exceeds `windowTokens` -
 * the oversize-chunk census.
 *
 * The quantity measured is the SAME one the embedding request path sizes
 * batches with (`estimateTokens`, characters over four), not the
 * `chunks.token_count` column: that column is the chunker's whitespace
 * WORD count, a different unit from a model's token window, and
 * comparing the two as though they matched is the arithmetic this census
 * exists to stop. The predicate is evaluated as a length comparison (see
 * `charLengthOverTokenBudget`) so the count is one aggregate and no chunk
 * body is read into memory.
 *
 * Known and bounded divergence: SQLite's `length()` over TEXT counts
 * Unicode CODE POINTS, while `String.length` in the estimator counts
 * UTF-16 code units. The two agree for every character in the Basic
 * Multilingual Plane and differ by one per supplementary-plane character
 * (emoji, rare CJK extensions), so this count is a lower bound - it can
 * miss a chunk that sits within (astral characters / 4) tokens of the
 * window, and can never report one that does not exceed it. bun:sqlite
 * exposes no user-defined-function hook, and UTF-16 length is not
 * derivable in SQL from code points and byte length, so an exact
 * in-database match is not available; the alternative is materialising
 * every chunk body, which costs more than the bound is worth.
 */
export function chunksOverTokenWindow(db: Database, windowTokens: number): number {
  const row = db
    .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM chunks WHERE length(content) > ?")
    .get(charLengthOverTokenBudget(windowTokens));
  return row?.n ?? 0;
}
