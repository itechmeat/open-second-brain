/**
 * Shared derived-artifact IO helper - one home for the write/read
 * convention the co-occurrence graph and the search-tuning store each
 * shipped separately (recall-quality wave, S2).
 *
 * A derived artifact is a pure function of an input set over the vault:
 * suggestions, learned parameters, learned vocabularies. None of it is
 * authorial content, so it is re-derivable at any time, and the storage
 * contract follows from that:
 *
 *   - SCHEMA-VERSIONED: `schema: "o2b.<name>.vN"` names the payload's
 *     shape; a reader built for another shape must never see these bytes.
 *   - DATASET-HASHED: `dataset_hash` fingerprints the input set the
 *     artifact was derived from, so a reader can tell that the vault has
 *     moved on and the stored derivation is stale.
 *   - FAIL-OPEN: a missing file, torn JSON, a schema mismatch, or a
 *     dataset-hash expiry all read as `null`. A derived artifact is a
 *     cache of a recomputable function; no consumer should ever be
 *     blocked by one, so every defect collapses to "not available" and
 *     the caller re-derives.
 *   - WRITTEN THROUGH THE RAILS: the write is atomic (temp file plus
 *     rename, so an interrupted run leaves the old artifact or the new
 *     one, never a hybrid) and passes the vault-identity guard, exactly
 *     like every other Brain write.
 *
 * Extraction only: co-occurrence and tuning keep their own code this
 * wave. New derived artifacts (entity lexicon, hallways) route through
 * here so the convention stops being copied.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { ensureInsideVault } from "../path-safety.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** The fields every derived artifact carries, beside its own payload. */
export interface DerivedArtifact {
  /** Schema tag of the payload shape, spelled `o2b.<name>.vN`. */
  schema: string;
  /** ISO instant the artifact was derived at. */
  generated_at: string;
  /** {@link deriveDatasetHash} over the input set the artifact was derived from. */
  dataset_hash: string;
}

/**
 * Fingerprint an input set: sha256 over the JSON encoding of its
 * deduplicated, lexicographically sorted parts. Order-independent and
 * duplicate-insensitive by construction, so two derivations over the
 * same SET of inputs agree on the hash regardless of walk order.
 */
export function deriveDatasetHash(parts: readonly string[]): string {
  const stable = [...new Set(parts)].toSorted();
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * Write a derived artifact to `<vaultDir>/<relPath>` atomically, guarded
 * by the vault-identity assertion every Brain write passes. Parent
 * directories are created as needed; the payload is pretty-printed JSON
 * with a trailing newline. Throws when `relPath` escapes the vault or
 * when the root's identity marker differs from the one this process
 * pinned - a refusal that arrives before the first byte.
 */
export function writeDerivedArtifact<T extends DerivedArtifact>(
  vaultDir: string,
  relPath: string,
  artifact: T,
): void {
  assertVaultIdentityForWrite(vaultDir);
  const path = ensureInsideVault(join(vaultDir, relPath), vaultDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

/**
 * Read a derived artifact written by {@link writeDerivedArtifact},
 * re-validated against `expectedSchema` and `datasetHash`. Returns
 * `null` - never throws - when the file is missing, the JSON is torn,
 * the document is not an object, `schema` or `generated_at` is not the
 * expected shape, the schema tag differs, or the stored dataset hash is
 * not the hash of the caller's current input set (fail-open). An
 * escaping `relPath` reads as `null` too, like every other absent
 * artifact.
 */
export function readDerivedArtifact<T extends DerivedArtifact>(
  vaultDir: string,
  relPath: string,
  expectedSchema: string,
  datasetHash: string,
): T | null {
  try {
    const path = ensureInsideVault(join(vaultDir, relPath), vaultDir);
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record["schema"] !== expectedSchema) return null;
    if (typeof record["generated_at"] !== "string") return null;
    if (record["dataset_hash"] !== datasetHash) return null;
    return Object.freeze(parsed as T);
  } catch {
    return null;
  }
}
