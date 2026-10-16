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
 *   - untrusted-source provenance: a page carrying the untrusted-source
 *     marker ({@link hasUntrustedSourceMarker}), which the intake boundary
 *     stamps when content enters the vault under untrusted provenance,
 *   - entity contamination: a page carrying the contamination module's
 *     marker ({@link ENTITY_CONTAMINATION_FRONTMATTER_KEY}).
 *
 * A quarantined candidate is never silently dropped: kernel 1 records it
 * with these reasons into the retrieval_decision_trace receipt, and the
 * relational arm's edge-level classification - which decides before the
 * pool, where no pool exclusion could ever name its drops - records its
 * arrivals on the arm lane of the same receipts, reach-filtered to pages
 * the caller could read.
 *
 * The gate runs under a resolved tri-state mode
 * ({@link SEARCH_TRUST_GATE_MODE}, session-mining-economy t_05a0eaa4):
 * `enforce` excludes as described above, `shadow` runs the same
 * classification, excludes nothing and records every would-be refusal
 * with its structural reasons into the receipts, and `off` - the default
 * - does not run the gate at all, keeping ranking and the outcome shape
 * byte-identical. The legacy boolean enable flag maps `true` to `shadow`.
 */

import type { FrontmatterMap } from "../../types.ts";
import { envOrConfig, parseBool } from "../../validate.ts";
import { SearchError } from "../../search/search-error.ts";
import {
  excludeVerdict,
  keepVerdict,
  type RankAdjuster,
  type RankAdjustVerdict,
} from "../../search/rank-adjust.ts";
// The row type from the declared leaf, not the `types.ts` aggregate that
// re-exports it: the aggregate resolves this module's mode, so naming the
// aggregate back from here would close an import cycle.
import type { BrainSearchResult } from "../../search/search-result.ts";
import { BRAIN_PREFERENCE_STATUS } from "../types.ts";
import { RETRIEVAL_TRUST_REFUSAL_LANE, type RetrievalTrustRefusal } from "./retrieval-receipts.ts";
import { hasUntrustedSourceMarker } from "./untrusted-provenance.ts";
import { hasEntityContaminationMarker } from "../truth/contamination.ts";

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

/**
 * The resolved posture of the gate (session-mining-economy, t_05a0eaa4):
 *   - `off`     - the gate does not run; ranking and the outcome shape
 *                 stay byte-identical,
 *   - `shadow`  - the classification runs, nothing is excluded, and every
 *                 would-be refusal is recorded with its structural reasons
 *                 into the receipts,
 *   - `enforce` - today's excluding behavior, made explicit.
 */
export const SEARCH_TRUST_GATE_MODE = Object.freeze({
  off: "off",
  shadow: "shadow",
  enforce: "enforce",
} as const);

export type SearchTrustGateMode =
  (typeof SEARCH_TRUST_GATE_MODE)[keyof typeof SEARCH_TRUST_GATE_MODE];

/** A mode under which the gate actually runs: shadow or enforce. */
export type ActiveSearchTrustGateMode = Exclude<SearchTrustGateMode, "off">;

/** True when `value` is one of the three mode tokens. */
export function isSearchTrustGateMode(value: string): value is SearchTrustGateMode {
  return (Object.values(SEARCH_TRUST_GATE_MODE) as string[]).includes(value);
}

/** Environment variable for the trust gate mode. */
export const SEARCH_TRUST_GATE_MODE_ENV = "OPEN_SECOND_BRAIN_SEARCH_TRUST_GATE_MODE";
/** Machine-config key for the trust gate mode. */
export const SEARCH_TRUST_GATE_MODE_CONFIG = "search_trust_gate_mode";
/** Environment variable of the legacy boolean enable flag. */
export const SEARCH_TRUST_GATE_LEGACY_ENV = "OPEN_SECOND_BRAIN_SEARCH_TRUST_GATE";
/** Machine-config key of the legacy boolean enable flag. */
export const SEARCH_TRUST_GATE_LEGACY_CONFIG = "search_trust_gate_enabled";

/**
 * Resolve the gate's mode: an explicit mode key wins (env over machine
 * config; an invalid value is a misconfiguration refused with a
 * `SearchError` naming the key actually in force - never silently
 * defaulted); absent the mode key, the legacy boolean maps `true` to
 * `shadow` and `false` to `off`; with neither set the default is `off`.
 * Shadow is non-destructive precisely so enablement can be the first
 * step: a vault that wants the excluding behavior names `enforce`.
 */
export function resolveSearchTrustGateMode(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: Readonly<Record<string, string>>;
}): SearchTrustGateMode {
  const env = input.env ?? {};
  const config = input.config ?? {};
  const raw = envOrConfig(env, config, SEARCH_TRUST_GATE_MODE_ENV, SEARCH_TRUST_GATE_MODE_CONFIG);
  if (raw !== null) {
    if (isSearchTrustGateMode(raw)) return raw;
    const inForce = env[SEARCH_TRUST_GATE_MODE_ENV]
      ? SEARCH_TRUST_GATE_MODE_ENV
      : SEARCH_TRUST_GATE_MODE_CONFIG;
    throw new SearchError(
      "INVALID_INPUT",
      `${inForce} must be 'off', 'shadow' or 'enforce', got '${raw}'`,
    );
  }
  const legacy = envOrConfig(
    env,
    config,
    SEARCH_TRUST_GATE_LEGACY_ENV,
    SEARCH_TRUST_GATE_LEGACY_CONFIG,
  );
  return legacy !== null && parseBool(legacy, false, SEARCH_TRUST_GATE_LEGACY_CONFIG)
    ? SEARCH_TRUST_GATE_MODE.shadow
    : SEARCH_TRUST_GATE_MODE.off;
}

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

/**
 * Classify a candidate's frontmatter as quarantined or clean. Pure and
 * O(1): three controlled-vocabulary key reads. Reasons are returned in a
 * deterministic (sorted) order so the receipt trace is stable.
 */
export function classifyRetrievalTrust(
  meta: Readonly<Record<string, unknown>>,
): RetrievalTrustVerdict {
  const reasons: string[] = [];
  if (hasEntityContaminationMarker(meta)) {
    reasons.push(RETRIEVAL_TRUST_EXCLUSION_REASON.entityContamination);
  }
  if (statusScalar(meta) === BRAIN_PREFERENCE_STATUS.quarantine) {
    reasons.push(RETRIEVAL_TRUST_EXCLUSION_REASON.selfApprovalQuarantine);
  }
  if (hasUntrustedSourceMarker(meta)) {
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
 *
 * Under `shadow` (session-mining-economy, t_05a0eaa4) the same
 * classification runs and every candidate is kept: the kernel's
 * single-pass verdict contract gains no kind, and the would-be refusals
 * are collected for the receipts by {@link collectTrustGateRefusals}
 * instead. `enforce` (the default) is the excluding behavior.
 */
export function trustGateAdjuster(
  readFrontmatter: (path: string) => FrontmatterMap,
  mode: ActiveSearchTrustGateMode = "enforce",
): RankAdjuster {
  return {
    name: RETRIEVAL_TRUST_GATE_NAME,
    adjust(result: BrainSearchResult): RankAdjustVerdict {
      const verdict = classifyRetrievalTrust(readFrontmatter(result.path));
      if (!verdict.quarantined) return keepVerdict();
      if (mode === "shadow") return keepVerdict();
      return excludeVerdict(verdict.reasons[0]!);
    },
  };
}

/**
 * Collect the pool lane's would-be refusals for the shadow mode: every
 * candidate the classification marks quarantined, as a compact reference
 * carrying ALL of its structural reasons (namespaced with the gate's
 * kernel name, matching how the kernel namespaces an exclusion), tagged
 * with the {@link RETRIEVAL_TRUST_REFUSAL_LANE.pool} lane. Nothing is
 * excluded here - the caller keeps ranking untouched and feeds the
 * returned record into the receipt build. Deterministic: pool order,
 * sorted reasons.
 */
export function collectTrustGateRefusals(
  ranked: ReadonlyArray<BrainSearchResult>,
  readFrontmatter: (path: string) => FrontmatterMap,
): RetrievalTrustRefusal[] {
  const refusals: RetrievalTrustRefusal[] = [];
  for (const candidate of ranked) {
    const verdict = classifyRetrievalTrust(readFrontmatter(candidate.path));
    if (!verdict.quarantined) continue;
    refusals.push(
      Object.freeze({
        document_id: candidate.documentId,
        chunk_id: candidate.chunkId,
        path: candidate.path,
        reasons: Object.freeze(
          verdict.reasons.map((reason) => `${RETRIEVAL_TRUST_GATE_NAME}:${reason}`),
        ),
        lane: RETRIEVAL_TRUST_REFUSAL_LANE.pool,
      }),
    );
  }
  return refusals;
}
