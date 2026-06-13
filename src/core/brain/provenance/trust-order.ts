/**
 * Provenance trust ordering for recall (Knowledge Provenance suite).
 *
 * When the `provenance_trust_ordering` guardrail is on, surfaced facts are
 * ordered so an operator-stated rule outranks a machine-derived one
 * (stated > deduced > inferred). The sort is stable, so facts of equal trust
 * keep their incoming order (e.g. the prior confidence ordering).
 *
 * Off by default: with the flag off the input order is returned unchanged, so
 * the surface is byte-identical.
 */

import { provenanceTrustRank, type ProvenanceLevel } from "./provenance.ts";

/** The provenance level of a record; absent reads as the most-trusted `stated`. */
export function provenanceLevelOf(record: {
  readonly provenance?: ProvenanceLevel;
}): ProvenanceLevel {
  return record.provenance ?? "stated";
}

/**
 * Stable-sort records by provenance trust (most-trusted first) when enabled.
 * Returns the input order unchanged when disabled.
 */
export function sortByProvenanceTrust<T extends { readonly provenance?: ProvenanceLevel }>(
  records: readonly T[],
  enabled: boolean,
): T[] {
  if (!enabled) return [...records];
  return [...records].toSorted(
    (a, b) => provenanceTrustRank(provenanceLevelOf(a)) - provenanceTrustRank(provenanceLevelOf(b)),
  );
}
