/**
 * The index census: one row-count per table the operator surfaces care
 * about, taken together so `o2b search status` reports a single
 * consistent picture rather than four independent probes.
 */

import { Database } from "bun:sqlite";

import { countChunks } from "./chunks.ts";
import { countDocuments } from "./documents.ts";
import { countEmbeddings, staleEmbeddings } from "./vectors.ts";

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
