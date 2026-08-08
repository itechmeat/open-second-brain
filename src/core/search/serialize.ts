/**
 * Snake_case wire serializers shared by the CLI (`o2b search`) and MCP
 * (`brain_search`) surfaces, so the two output contracts cannot drift
 * field-by-field the way independently hand-written copies do.
 */

import type { StampMismatch } from "../integrity/stamp.ts";
import type { ChunkWindowCensus, IndexStatusSnapshot, SearchCard } from "./types.ts";

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
    // Exact-duplicate merge (task D): the `path:Lstart-Lend` pointers the
    // surviving card was folded from. Absent, never null, when nothing
    // was merged - the card carries the key only in that case.
    ...(c.duplicatePointers !== undefined ? { duplicate_pointers: c.duplicatePointers } : {}),
  };
}

/**
 * Wire shape of an oversize-chunk census verdict, shared by the index
 * run's report and the status snapshot so the two cannot describe one
 * verdict with different field names.
 *
 * No `next_command` here: whether a surface names an exit beside a
 * verdict is that surface's decision, and the index run spreads its own
 * on top. Baking one in would put a command on the status field the
 * ruling deliberately keeps out of the warning channel.
 */
export function serializeChunkWindowCensus(census: ChunkWindowCensus): Record<string, unknown> {
  if (census.verdict === "window-undeclared") {
    return {
      verdict: census.verdict,
      model: census.model,
      chunks_measured: census.chunksMeasured,
    };
  }
  if (census.verdict === "estimate-undecided") {
    // No `chunks_over_window` here on the same terms the undeclared
    // verdict carries no window: nothing was proved over it.
    return {
      verdict: census.verdict,
      model: census.model,
      window_tokens: census.windowTokens,
      chunks_undecided: census.chunksUndecided,
      chunks_measured: census.chunksMeasured,
    };
  }
  return {
    verdict: census.verdict,
    model: census.model,
    window_tokens: census.windowTokens,
    chunks_over_window: census.chunksOverWindow,
    // Absent, never zero - an index the estimate decided in full emits
    // the record it emitted before the undecided band existed.
    ...(census.chunksUndecided === undefined ? {} : { chunks_undecided: census.chunksUndecided }),
    chunks_measured: census.chunksMeasured,
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
    // Emitted only when the oversize-chunk census could NOT run, on the
    // same terms and for the same reason: a status over a model with a
    // declared window is byte-identical to the pre-census output. The
    // two verdicts the census reaches by measuring - overflow, and the
    // band its estimate cannot decide - are not here; both are warnings,
    // because both name a command.
    ...(s.chunkWindowUndeclared === undefined
      ? {}
      : { chunk_window_undeclared: serializeChunkWindowCensus(s.chunkWindowUndeclared) }),
    warnings: s.warnings,
  };
}
