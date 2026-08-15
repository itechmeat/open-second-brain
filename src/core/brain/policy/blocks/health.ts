/**
 * The `health:` block — the semantic-health detector thresholds, the
 * remediation step cap, and the wall-clock ceiling past which a
 * materialized artifact stops counting as fresh.
 *
 * One reason to change: what the health knobs are tuned by. The
 * materialize ceiling lives here rather than in a block of its own
 * because it answers the same operator question as
 * `stale_claim_max_age_days` — how old is too old before this vault
 * stops trusting something it derived — and a one-key block would put
 * a second answer to that question in a second place.
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
  "materialize_max_age_days",
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
 *   - `materialize_max_age_days: 30` - a derived artifact stops being
 *     fresh a month after it was written even if no input moved. Chosen
 *     short enough that the "fresh forever" defect it closes cannot
 *     outlive a release cycle - the algorithm that produced the artifact
 *     changes between releases, and the mtime comparison cannot see
 *     that - and long enough that `--if-stale` is still a useful
 *     fast-path in a vault being worked in daily. Deliberately NOT the
 *     180 of `stale_claim_max_age_days`, which would leave half a year
 *     of the same defect.
 */
export const BRAIN_HEALTH_DEFAULTS: ResolvedBrainHealthConfig = Object.freeze({
  contradiction_jaccard: 0.5,
  concept_gap_min_frequency: 3,
  stale_claim_max_age_days: 180,
  remediation_step_cap: 20,
  materialize_max_age_days: 30,
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
    materialize_max_age_days:
      h.materialize_max_age_days ?? BRAIN_HEALTH_DEFAULTS.materialize_max_age_days,
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
 *     materialize_max_age_days: 30
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
