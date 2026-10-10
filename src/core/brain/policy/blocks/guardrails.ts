/**
 * The `guardrails:` block — the dream pass self-approval thresholds and
 * the opt-in provenance toggles.
 *
 * One reason to change: which guardrail knobs exist and what they accept.
 * Default table, read-side resolver and parser sit together because a new
 * guardrail always touches all three.
 */

import type {
  BrainConfig,
  BrainGuardrailConfig,
  ResolvedBrainGuardrailConfig,
} from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe, requireNonNegativeInteger, requirePositiveInteger } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "guardrails";

/**
 * Hard upper bound on `guardrails.instruction_file_max_lines`. Any
 * value above this is a misconfiguration - vault-root instruction
 * files are intended to stay small for compliance reasons, so a
 * ceiling like 100000 lines silently disables the warning.
 */
export const INSTRUCTION_FILE_MAX_LINES_CEILING = 10000;

/**
 * Knowledge Provenance opt-in boolean flags (v1.7). Present → must be
 * boolean, else hard error. Named once so the parser, the forward-compat
 * unknown-key warning and the resolver read the same list.
 *
 * `ambient_writeback` (write-side-trust wave, Task 11) is the one flag
 * whose absent-behaviour is ON: ambient extraction is today's lane, so
 * its default is `true` and only an explicit `false` suppresses.
 */
const BOOLEAN_KEYS = [
  "untrusted_source_delimiting",
  "derived_fact_synthesis",
  "provenance_trust_ordering",
  "owner_scoped_facts",
  "marker_writeback",
  "ambient_writeback",
] as const;

const KNOWN_KEYS = [
  "promotion_min_signals",
  "promotion_min_distinct_agents",
  "promotion_min_age_days",
  "instruction_file_max_lines",
  "ambient_ttl_days",
  ...BOOLEAN_KEYS,
] as const;

/**
 * Default `guardrails` block (v0.10.16). When `_brain.yaml` omits
 * `guardrails` (or omits individual fields), `resolveGuardrails`
 * returns these values so consumers can rely on a fully-populated
 * struct.
 *
 * Defaults are chosen to be strictly looser than every existing
 * dream-pass gate so adding the guardrail cannot block a promotion
 * that previously succeeded:
 *   - `promotion_min_signals: 1` is below any sane
 *     `dream.candidate_threshold` (default 3). When an operator
 *     tunes `candidate_threshold` below 2, the guardrail still
 *     cannot block them by default - explicit opt-in is required
 *     via the `_brain.yaml:guardrails:promotion_min_signals` field.
 *   - `promotion_min_distinct_agents: 1` imposes no cross-agent
 *     requirement.
 *   - `promotion_min_age_days: 0` disables the age gate.
 *   - `instruction_file_max_lines: 200` matches the documented
 *     compliance ceiling.
 *   - `ambient_writeback: true` keeps the ambient extraction lane
 *     running (write-side-trust wave, Task 11); only an explicit
 *     `false` suppresses a capture.
 *   - `ambient_ttl_days: 0` stamps no expiration date, so ambient
 *     signals never expire on their own.
 */
export const BRAIN_GUARDRAIL_DEFAULTS: ResolvedBrainGuardrailConfig = Object.freeze({
  promotion_min_signals: 1,
  promotion_min_distinct_agents: 1,
  promotion_min_age_days: 0,
  instruction_file_max_lines: 200,
  untrusted_source_delimiting: false,
  derived_fact_synthesis: false,
  provenance_trust_ordering: false,
  owner_scoped_facts: false,
  marker_writeback: false,
  ambient_writeback: true,
  ambient_ttl_days: 0,
}) as ResolvedBrainGuardrailConfig;

/**
 * Merge a parsed `guardrails` block (or `undefined`) with
 * `BRAIN_GUARDRAIL_DEFAULTS`. Returns a fully-populated struct so
 * consumers do not branch on optional fields.
 */
export function resolveGuardrails(cfg: BrainConfig): ResolvedBrainGuardrailConfig {
  const g = cfg.guardrails;
  if (g === undefined) return BRAIN_GUARDRAIL_DEFAULTS;
  return {
    promotion_min_signals:
      g.promotion_min_signals ?? BRAIN_GUARDRAIL_DEFAULTS.promotion_min_signals,
    promotion_min_distinct_agents:
      g.promotion_min_distinct_agents ?? BRAIN_GUARDRAIL_DEFAULTS.promotion_min_distinct_agents,
    promotion_min_age_days:
      g.promotion_min_age_days ?? BRAIN_GUARDRAIL_DEFAULTS.promotion_min_age_days,
    instruction_file_max_lines:
      g.instruction_file_max_lines ?? BRAIN_GUARDRAIL_DEFAULTS.instruction_file_max_lines,
    untrusted_source_delimiting:
      g.untrusted_source_delimiting ?? BRAIN_GUARDRAIL_DEFAULTS.untrusted_source_delimiting,
    derived_fact_synthesis:
      g.derived_fact_synthesis ?? BRAIN_GUARDRAIL_DEFAULTS.derived_fact_synthesis,
    provenance_trust_ordering:
      g.provenance_trust_ordering ?? BRAIN_GUARDRAIL_DEFAULTS.provenance_trust_ordering,
    owner_scoped_facts: g.owner_scoped_facts ?? BRAIN_GUARDRAIL_DEFAULTS.owner_scoped_facts,
    marker_writeback: g.marker_writeback ?? BRAIN_GUARDRAIL_DEFAULTS.marker_writeback,
    ambient_writeback: g.ambient_writeback ?? BRAIN_GUARDRAIL_DEFAULTS.ambient_writeback,
    ambient_ttl_days: g.ambient_ttl_days ?? BRAIN_GUARDRAIL_DEFAULTS.ambient_ttl_days,
  };
}

/**
 * Hard-error on shape problems - thresholds are operator-tunable and
 * silent fallback would mask the operator's intent. Missing block leaves
 * `cfg.guardrails` undefined; `resolveGuardrails` injects defaults on the
 * read side so consumers receive a fully-populated struct.
 */
export function parseGuardrailsBlock(ctx: BlockParseContext): BrainGuardrailConfig | undefined {
  const rawMap = openBlock(ctx, BLOCK);
  if (rawMap === undefined) return undefined;

  const partial: {
    promotion_min_signals?: number;
    promotion_min_distinct_agents?: number;
    promotion_min_age_days?: number;
    instruction_file_max_lines?: number;
    ambient_ttl_days?: number;
    untrusted_source_delimiting?: boolean;
    derived_fact_synthesis?: boolean;
    provenance_trust_ordering?: boolean;
    owner_scoped_facts?: boolean;
    marker_writeback?: boolean;
    ambient_writeback?: boolean;
  } = {};

  if ("promotion_min_signals" in rawMap) {
    requirePositiveInteger(
      "guardrails.promotion_min_signals",
      rawMap["promotion_min_signals"],
      ctx.source,
    );
    partial.promotion_min_signals = rawMap["promotion_min_signals"] as number;
  }
  if ("promotion_min_distinct_agents" in rawMap) {
    requirePositiveInteger(
      "guardrails.promotion_min_distinct_agents",
      rawMap["promotion_min_distinct_agents"],
      ctx.source,
    );
    partial.promotion_min_distinct_agents = rawMap["promotion_min_distinct_agents"] as number;
  }
  if ("promotion_min_age_days" in rawMap) {
    requireNonNegativeInteger(
      "guardrails.promotion_min_age_days",
      rawMap["promotion_min_age_days"],
      ctx.source,
    );
    partial.promotion_min_age_days = rawMap["promotion_min_age_days"] as number;
  }
  if ("instruction_file_max_lines" in rawMap) {
    requirePositiveInteger(
      "guardrails.instruction_file_max_lines",
      rawMap["instruction_file_max_lines"],
      ctx.source,
    );
    const v = rawMap["instruction_file_max_lines"] as number;
    if (v > INSTRUCTION_FILE_MAX_LINES_CEILING) {
      throw new BrainConfigError(
        `must be at most ${INSTRUCTION_FILE_MAX_LINES_CEILING}; got ${describe(v)}`,
        "guardrails.instruction_file_max_lines",
        ctx.source,
      );
    }
    partial.instruction_file_max_lines = v;
  }
  if ("ambient_ttl_days" in rawMap) {
    requireNonNegativeInteger(
      "guardrails.ambient_ttl_days",
      rawMap["ambient_ttl_days"],
      ctx.source,
    );
    partial.ambient_ttl_days = rawMap["ambient_ttl_days"] as number;
  }
  for (const key of BOOLEAN_KEYS) {
    if (!(key in rawMap)) continue;
    const flag = rawMap[key];
    if (typeof flag !== "boolean") {
      throw new BrainConfigError(
        `must be a boolean; got ${describe(flag)}`,
        `guardrails.${key}`,
        ctx.source,
      );
    }
    partial[key] = flag;
  }

  warnUnknownKeys(ctx, rawMap, KNOWN_KEYS, BLOCK);
  // A block present but carrying only unknown fields still yields an
  // empty struct, so `cfg.guardrails` stays non-undefined and
  // distinguishable from "block absent entirely".
  return partial;
}
