/**
 * The embedding ABI an index was written under versus the one this build
 * would produce (context-integrity-gates, Unit E): reading the recorded
 * tokens, deriving the runtime ones, and naming the drift between them.
 *
 * Both sides of the comparison are built here so they can never cover
 * different fields.
 */

import type { StampMismatch, StampTokens } from "../../integrity/stamp.ts";
import { formatStampMismatch } from "../../integrity/stamp.ts";

import type { ResolvedSearchConfig } from "../types.ts";
import {
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_MODEL_STATE_KEY,
  EMBEDDING_VEC_VERSION_STATE_KEY,
  withReadonlyIndex,
} from "./state.ts";

/**
 * The single remediation for embedding-ABI drift, named once so the
 * store's refusal, the status warning and the `search check`
 * recommendation cannot grow three spellings of the same instruction.
 */
export const EMBEDDING_ABI_FIX_COMMAND = "o2b search reindex --embeddings";

/** The ABI tokens an index recorded, read through any state accessor. */
export function recordedEmbeddingAbi(state: (key: string) => string | null): StampTokens {
  return {
    [EMBEDDING_MODEL_STATE_KEY]: state(EMBEDDING_MODEL_STATE_KEY),
    [EMBEDDING_DIMENSION_STATE_KEY]: state(EMBEDDING_DIMENSION_STATE_KEY),
    [EMBEDDING_VEC_VERSION_STATE_KEY]: state(EMBEDDING_VEC_VERSION_STATE_KEY),
  };
}

/**
 * The ABI tokens the CURRENT build and configuration would produce. The
 * counterpart of {@link recordedEmbeddingAbi}, kept beside it so the two
 * sides of the comparison can never cover different fields.
 */
export function runtimeEmbeddingAbi(
  config: ResolvedSearchConfig,
  vecVersion: string | null,
): StampTokens {
  return {
    [EMBEDDING_MODEL_STATE_KEY]: config.semantic.model,
    [EMBEDDING_DIMENSION_STATE_KEY]:
      config.semantic.dimension === null ? null : String(config.semantic.dimension),
    [EMBEDDING_VEC_VERSION_STATE_KEY]: vecVersion,
  };
}

/**
 * Embedding-ABI tokens recorded in an index, without opening a `Store`.
 *
 * `indexCheck` needs these and cannot get them from its own probe: it
 * deliberately runs against an IN-MEMORY database and never touches the
 * real index, so a stored-versus-runtime comparison there has no stored
 * side unless one is read explicitly.
 *
 * `null` means the index is absent or unreadable - not that its ABI
 * matches.
 */
export function readEmbeddingAbiSync(dbPath: string): StampTokens | null {
  return withReadonlyIndex(dbPath, (read) => recordedEmbeddingAbi(read));
}

/**
 * The subset of an ABI comparison the index actually CONTRADICTS: it
 * recorded a token and that token disagrees with this build.
 *
 * A mismatch whose recorded side is `null` is an UNRECORDED field - a
 * store written before that token was stamped. An absent marker cannot
 * tell an old store from a wrong one, so it is reported on the
 * diagnostic surfaces and never drives a refusal or a per-read warning.
 * Both consumers of that distinction (the `fail` verdict's refusal and
 * the query path's warning) route through here rather than restating
 * the predicate, so they cannot drift on what counts as contradicted.
 */
export function contradictedAbiFields(
  mismatches: ReadonlyArray<StampMismatch>,
): ReadonlyArray<StampMismatch> {
  return mismatches.filter((m) => m.expected !== null);
}

/**
 * One operator-facing line for embedding-ABI drift. Shared by the read
 * open's refusal, the status warning and the `search check`
 * recommendation, so the three cannot describe the same condition
 * differently or name different fixes.
 */
export function formatEmbeddingAbiDrift(mismatches: ReadonlyArray<StampMismatch>): string {
  return (
    `embedding ABI drift between the stored index and this build ` +
    `(${mismatches.map(formatStampMismatch).join("; ")}); stored vectors are not ` +
    `comparable to queries embedded now. Run: ${EMBEDDING_ABI_FIX_COMMAND}`
  );
}
