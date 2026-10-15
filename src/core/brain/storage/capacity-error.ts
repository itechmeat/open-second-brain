/**
 * The typed failure vocabulary of the storage lifecycle: the closed
 * code union and the {@link StorageCapacityError} carrier.
 *
 * A LEAF by construction - it imports nothing, exactly like
 * `SearchError` in `src/core/search/search-error.ts`, so every module
 * that raises or catches a capacity condition can depend on it without
 * dragging the storage modules (or the policy layer) into its import
 * graph.
 *
 * Two codes, and the difference is the whole vocabulary:
 *
 *   - `capacity_unmeasurable` - the census could not be taken, so no
 *     capacity question has an answer. Refusal by name is the honest
 *     state: a gate that read an unmeasurable store as "plenty of room"
 *     would be the silent no-op this project forbids.
 *   - `capacity_exhausted` - the store measured past the critical
 *     threshold, and the write that asked is refused before it lands.
 */

export const STORAGE_ERROR_CODES = ["capacity_unmeasurable", "capacity_exhausted"] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export class StorageCapacityError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageCapacityError";
    this.code = code;
  }
}
