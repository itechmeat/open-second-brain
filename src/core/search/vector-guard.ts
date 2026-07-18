/**
 * Vector validity kernel (memory-write-path-integrity B1). A single
 * choke-point guard shared by the store write path (`vecUpsert`), the store
 * query path (`semanticTopK`), and provider normalisation
 * (`unitNormaliseInPlace`). A NaN/Infinity component silently poisons every
 * cosine distance it participates in, and an all-zero vector has no direction
 * at all - both are exactly the misleading no-op inputs this project forbids,
 * so they surface as a typed, actionable {@link SearchError} instead of
 * reaching the vec table or degrading ranking silently.
 */

import { SearchError } from "./types.ts";

/**
 * Throw {@link SearchError} `EMBEDDING_INVALID_VECTOR` when `vector` is empty,
 * carries a non-finite component (NaN/Infinity), or is all zeros. The message
 * names `context` (e.g. "vecUpsert", "semanticTopK", "unitNormalise") and the
 * offending index/reason so the failure is actionable at the call site.
 */
export function assertValidVector(
  vector: ReadonlyArray<number> | Float32Array,
  context: string,
): void {
  if (vector.length === 0) {
    throw new SearchError("EMBEDDING_INVALID_VECTOR", `${context}: embedding vector is empty`);
  }
  let allZero = true;
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index] as number;
    if (!Number.isFinite(value)) {
      throw new SearchError(
        "EMBEDDING_INVALID_VECTOR",
        `${context}: embedding vector has non-finite value ${value} at index ${index}`,
      );
    }
    if (value !== 0) allZero = false;
  }
  if (allZero) {
    throw new SearchError(
      "EMBEDDING_INVALID_VECTOR",
      `${context}: embedding vector is all zeros (no direction for cosine similarity)`,
    );
  }
}
