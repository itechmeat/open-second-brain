/**
 * Snake_case wire serializers shared by the CLI (`o2b search`) and MCP
 * (`brain_search`) surfaces, so the two output contracts cannot drift
 * field-by-field the way independently hand-written copies do.
 */

import type { StampMismatch } from "../integrity/stamp.ts";
import type { IndexStatusSnapshot, SearchCard } from "./types.ts";

/**
 * Wire shape for a stamp comparison. `recorded` is what the index
 * wrote, `runtime` what this build would write; a `recorded` of `null`
 * is a field the index never stamped. Shared by `o2b search check`,
 * `o2b search status --json` and the MCP `search.*` status block, so
 * one drift cannot be described three ways.
 */
export function serializeStampMismatches(
  mismatches: ReadonlyArray<StampMismatch>,
): Array<Record<string, unknown>> {
  return mismatches.map((m) => ({
    field: m.field,
    recorded: m.expected,
    runtime: m.actual,
  }));
}

/** Layer-1 card projection - identical shape on both the CLI and MCP surfaces. */
export function serializeSearchCard(c: SearchCard): Record<string, unknown> {
  return {
    path: c.path,
    title: c.title,
    score: c.score,
    snippet: c.snippet,
    pointer: c.pointer,
    reasons: c.reasons,
    document_id: c.documentId,
    chunk_id: c.chunkId,
    ...(c.origin !== undefined ? { origin: c.origin } : {}),
  };
}

/**
 * Full snake_case index-status mapping. The CLI surfaces every field; the
 * MCP block (token-budget conscious) picks a subset of the returned object
 * rather than re-declaring the mapping.
 */
export function serializeIndexStatus(s: IndexStatusSnapshot): Record<string, unknown> {
  return {
    index_path: s.indexPath,
    exists: s.exists,
    schema_version: s.schemaVersion,
    documents: s.documents,
    chunks: s.chunks,
    embeddings: s.embeddings,
    stale_embeddings: s.staleEmbeddings,
    embedding_model: s.embeddingModel,
    embedding_dimension: s.embeddingDimension,
    embedding_signature: s.embeddingSignature,
    estimated_refresh_cost_usd: s.estimatedRefreshCostUsd,
    vec_extension: s.vecExtension,
    semantic_enabled: s.semanticEnabled,
    embedding_key_present: s.embeddingKeyPresent,
    last_indexed_at: s.lastIndexedAt,
    last_full_index_at: s.lastFullIndexAt,
    // Emitted only on drift, so a matching store's JSON is byte-identical
    // to the pre-gate output (context-integrity-gates, Unit E).
    ...(s.embeddingAbi.length > 0
      ? { embedding_abi: serializeStampMismatches(s.embeddingAbi) }
      : {}),
    warnings: s.warnings,
  };
}
