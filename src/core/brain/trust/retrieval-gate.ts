/**
 * Retrieval trust gate (t_5f61130a) - the first consumer of kernel 1
 * (src/core/search/rank-adjust.ts).
 *
 * The gate contributes an exclude-with-reason verdict for quarantined
 * material so it ranks zero and reaches no pack. Classification is
 * DETERMINISTIC and reads only controlled-vocabulary frontmatter keys -
 * never note prose - so there is no natural-language word list anywhere.
 * The three structural / provenance signals are each already owned by an
 * existing module; the gate reuses their exported identities:
 *
 *   - self-approval guardrail state: a preference whose persisted status
 *     is `quarantine` ({@link BRAIN_PREFERENCE_STATUS.quarantine}, written
 *     by the dream self-approval guardrail),
 *   - untrusted-source provenance: a page flagged with the untrusted-source
 *     module's own tag ({@link UNTRUSTED_SOURCE_TAG}),
 *   - entity contamination: a page carrying the contamination module's
 *     marker ({@link ENTITY_CONTAMINATION_FRONTMATTER_KEY}).
 *
 * A quarantined candidate is never silently dropped: kernel 1 records it
 * with these reasons into the retrieval_decision_trace receipt.
 */

import type { FrontmatterMap } from "../../types.ts";
import {
  excludeVerdict,
  keepVerdict,
  type RankAdjuster,
  type RankAdjustVerdict,
} from "../../search/rank-adjust.ts";
import type { BrainSearchResult } from "../../search/types.ts";
import { BRAIN_PREFERENCE_STATUS } from "../types.ts";
import { UNTRUSTED_SOURCE_TAG } from "../untrusted-source.ts";
import { ENTITY_CONTAMINATION_FRONTMATTER_KEY } from "../truth/contamination.ts";

/** Namespace name kernel 1 uses when attributing the gate's exclusions. */
export const RETRIEVAL_TRUST_GATE_NAME = "trust_gate";

/**
 * Structural exclusion reasons the gate emits, one per signal source.
 * Fixed tokens (not prose) so the same vault yields the same trace.
 */
export const RETRIEVAL_TRUST_EXCLUSION_REASON = Object.freeze({
  selfApprovalQuarantine: "self_approval_quarantine",
  untrustedSourceProvenance: "untrusted_source_provenance",
  entityContamination: "entity_contamination",
} as const);

export interface RetrievalTrustVerdict {
  readonly quarantined: boolean;
  /** Structural reasons, sorted for a deterministic trace. */
  readonly reasons: ReadonlyArray<string>;
}

const CLEAN: RetrievalTrustVerdict = Object.freeze({
  quarantined: false,
  reasons: Object.freeze([]),
});

function statusScalar(meta: Readonly<Record<string, unknown>>): string | null {
  // Tolerant of both the on-disk `status` and the normalized `_status`
  // shape, mirroring how the lifecycle reader reads a status field.
  const raw = meta["status"] ?? meta["_status"];
  return typeof raw === "string" ? raw.trim().toLowerCase() : null;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Classify a candidate's frontmatter as quarantined or clean. Pure and
 * O(1): three controlled-vocabulary key reads. Reasons are returned in a
 * deterministic (sorted) order so the receipt trace is stable.
 */
export function classifyRetrievalTrust(
  meta: Readonly<Record<string, unknown>>,
): RetrievalTrustVerdict {
  const reasons: string[] = [];
  if (truthy(meta[ENTITY_CONTAMINATION_FRONTMATTER_KEY])) {
    reasons.push(RETRIEVAL_TRUST_EXCLUSION_REASON.entityContamination);
  }
  if (statusScalar(meta) === BRAIN_PREFERENCE_STATUS.quarantine) {
    reasons.push(RETRIEVAL_TRUST_EXCLUSION_REASON.selfApprovalQuarantine);
  }
  if (truthy(meta[UNTRUSTED_SOURCE_TAG])) {
    reasons.push(RETRIEVAL_TRUST_EXCLUSION_REASON.untrustedSourceProvenance);
  }
  if (reasons.length === 0) return CLEAN;
  return Object.freeze({ quarantined: true, reasons: Object.freeze(reasons.toSorted()) });
}

/**
 * Build the kernel-1 adjuster. The caller supplies a frontmatter reader
 * (the per-query cached reader in search.ts) so the gate does no I/O of
 * its own. A quarantined candidate is excluded with the FIRST structural
 * reason; every reason still reaches the receipt via
 * {@link classifyRetrievalTrust} at trace-build time.
 */
export function trustGateAdjuster(readFrontmatter: (path: string) => FrontmatterMap): RankAdjuster {
  return {
    name: RETRIEVAL_TRUST_GATE_NAME,
    adjust(result: BrainSearchResult): RankAdjustVerdict {
      const verdict = classifyRetrievalTrust(readFrontmatter(result.path));
      if (!verdict.quarantined) return keepVerdict();
      return excludeVerdict(verdict.reasons[0]!);
    },
  };
}
