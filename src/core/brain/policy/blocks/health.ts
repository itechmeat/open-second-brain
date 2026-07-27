/**
 * The `health:` block — the semantic-health detector thresholds and the
 * remediation step cap.
 *
 * One reason to change: what the health detectors are tuned by.
 */

import type { BrainConfig, BrainHealthConfig, ResolvedBrainHealthConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";
import { isValidIsoInstant } from "../../health/iso-time.ts";

const BLOCK = "health";

/** Sub-keys whose value is a plain positive integer count of days/steps. */
const POSITIVE_INT_KEYS = [
  "concept_gap_min_frequency",
  "stale_claim_max_age_days",
  "remediation_step_cap",
] as const;

/**
 * Default `health:` block (v0.14.0). Drives the semantic-health
 * detectors and the remediation step cap. Absent block falls back here
 * via `resolveHealth`:
 *
 *   - `contradiction_jaccard: 0.5` - two confirmed preferences must
 *     share at least half their principle tokens (and carry opposite
 *     signs) to count as a contradiction.
 *   - `concept_gap_min_frequency: 3` - an entity must recur across 3
 *     distinct corpus entries before an uncovered-concept gap fires.
 *   - `stale_claim_max_age_days: 180` - 6 months without fresh
 *     evidence before a confirmed preference is flagged stale.
 *   - `remediation_step_cap: 20` - a single `doctor --remediate` run
 *     applies at most 20 auto-safe repairs.
 */
export const BRAIN_HEALTH_DEFAULTS: ResolvedBrainHealthConfig = Object.freeze({
  contradiction_jaccard: 0.5,
  concept_gap_min_frequency: 3,
  stale_claim_max_age_days: 180,
  remediation_step_cap: 20,
  silence_before: null,
}) as ResolvedBrainHealthConfig;

/**
 * Merge a parsed `health` block (or `undefined`) with
 * `BRAIN_HEALTH_DEFAULTS`.
 */
export function resolveHealth(cfg: BrainConfig): ResolvedBrainHealthConfig {
  const h = cfg.health;
  if (h === undefined) return BRAIN_HEALTH_DEFAULTS;
  return {
    contradiction_jaccard: h.contradiction_jaccard ?? BRAIN_HEALTH_DEFAULTS.contradiction_jaccard,
    concept_gap_min_frequency:
      h.concept_gap_min_frequency ?? BRAIN_HEALTH_DEFAULTS.concept_gap_min_frequency,
    stale_claim_max_age_days:
      h.stale_claim_max_age_days ?? BRAIN_HEALTH_DEFAULTS.stale_claim_max_age_days,
    remediation_step_cap: h.remediation_step_cap ?? BRAIN_HEALTH_DEFAULTS.remediation_step_cap,
    silence_before: h.silence_before ?? BRAIN_HEALTH_DEFAULTS.silence_before,
  };
}

/**
 * Shape:
 *   health:
 *     contradiction_jaccard: 0.5   # float in (0, 1]
 *     concept_gap_min_frequency: 3 # positive integer
 *     stale_claim_max_age_days: 180
 *     remediation_step_cap: 20
 *     silence_before: "2026-01-01" # ISO date/timestamp (watermark)
 */
export function parseHealthBlock(ctx: BlockParseContext): BrainHealthConfig | undefined {
  const hObj = openBlock(ctx, BLOCK);
  if (hObj === undefined) return undefined;

  const partial: Record<string, unknown> = {};
  if ("contradiction_jaccard" in hObj) {
    const v = hObj["contradiction_jaccard"];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) {
      throw new BrainConfigError(
        "must be a finite number in (0, 1]",
        "health.contradiction_jaccard",
        ctx.source,
      );
    }
    partial["contradiction_jaccard"] = v;
  }
  for (const key of POSITIVE_INT_KEYS) {
    if (!(key in hObj)) continue;
    const v = hObj[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new BrainConfigError("must be a positive integer", `health.${key}`, ctx.source);
    }
    partial[key] = v;
  }
  if ("silence_before" in hObj) {
    const v = hObj["silence_before"];
    if (typeof v !== "string" || !isValidIsoInstant(v)) {
      throw new BrainConfigError(
        "must be an ISO-8601 date (YYYY-MM-DD) or timestamp",
        "health.silence_before",
        ctx.source,
      );
    }
    partial["silence_before"] = v;
  }
  warnUnknownKeys(
    ctx,
    hObj,
    ["contradiction_jaccard", ...POSITIVE_INT_KEYS, "silence_before"],
    BLOCK,
  );
  return partial as BrainHealthConfig;
}
