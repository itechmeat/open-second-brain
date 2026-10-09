/**
 * The extraction-contract fingerprint (t_586d5d8b).
 *
 * The content-hash manifest ({@link ./content-manifest.ts}) gates re-ingest
 * on BYTES alone: a source whose bytes are unchanged since its last ingest is
 * skipped, and answers with extraction shaped by whatever contract produced
 * its stored page - even after the extraction behavior changed. This module
 * names that contract so the manifest can record it and the planner can
 * refuse to skip under a changed one. The fingerprint covers everything
 * CODE-scoped that shapes extraction: the vault's schema `extractable`
 * allowlist plus the hand-bumped {@link EXTRACT_CONTRACT_VERSION} constant.
 *
 * Deliberately OUT of the fingerprint: per-call planning options
 * (`pre_extract`, `extensions`, `exclude`, the batch caps). They shape one
 * planning call, not the contract a stored page was extracted under - the
 * same scope-vs-options split the session-summary lane draws.
 *
 * Pure: the fingerprint is a function of the vault's config text and the
 * version constant alone - no clock, no absolute paths, no per-call options -
 * so two peers holding the same vault config compute the same value, and a
 * fingerprint recorded in one replica's manifest means the same contract on
 * every other.
 *
 * Language-agnostic: schema tokens in, hex out; no natural-language content
 * is inspected.
 */

import { canonicalJson, sha256Hex } from "../../integrity/digest.ts";
import { loadSchemaPack } from "../schema-pack.ts";

/**
 * Version of the extraction contract. A stored page answers with the
 * contract that produced it, so a change to code-scoped extraction behavior
 * must bump this: the planner compares the manifest's recorded fingerprint
 * against the live one and reprocesses every source once when they differ
 * (the `CHUNKER_VERSION` bump-guard convention).
 *
 *   1 - the pre-fingerprint era: reprocessing was gated on content bytes
 *       alone, so no contract was ever recorded; manifests written then are
 *       read as changed.
 *   2 - the fingerprint exists and is recorded in the ingest manifest's
 *       manifest-wide `contract` field (t_586d5d8b).
 */
export const EXTRACT_CONTRACT_VERSION = 2;

/** Characters of the SHA-256 hex kept - short like the plan id, not a digest. */
const FINGERPRINT_HEX_CHARS = 16;

/**
 * The pure combiner behind {@link computeExtractionContractFingerprint}: the
 * fingerprint over a contract version and the schema `extractable` allowlist.
 * The allowlist is sorted before hashing so its spelling order - which the
 * schema parser preserves - cannot change the value.
 */
export function extractionContractFingerprint(
  version: number,
  extractable: readonly string[],
): string {
  const body = { version, extractable: [...extractable].toSorted() };
  return sha256Hex(canonicalJson(body)).slice(0, FINGERPRINT_HEX_CHARS);
}

/**
 * The extraction contract of `vault`: the fingerprint over this build's
 * {@link EXTRACT_CONTRACT_VERSION} and the vault's schema `extractable`
 * allowlist. See the module header for what is deliberately not folded in.
 */
export function computeExtractionContractFingerprint(vault: string): string {
  return extractionContractFingerprint(EXTRACT_CONTRACT_VERSION, loadSchemaPack(vault).extractable);
}
