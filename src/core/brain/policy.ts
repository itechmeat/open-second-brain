/**
 * Brain configuration loader and validator (`Brain/_brain.yaml`).
 *
 * The Brain config is nested two levels deep (top-level keys, each
 * containing a flat `key: number` block) — too rich for the
 * `parseSimpleYaml` flat parser used by the plugin config, but a far cry
 * from needing a real YAML library. We ship a tiny indent-aware parser
 * limited to:
 *
 *   - `# comments` and blank lines
 *   - `key: <scalar>` (numbers parsed; quoted strings stripped)
 *   - `key:` followed by an indented block of the same form (one level)
 *   - `key: []` and simple inline scalar arrays (`[a, "b"]`)
 *
 * Anything else is treated as invalid and surfaces through
 * `validateBrainConfig` with a field-named error. No external
 * dependency, no eval, no surprise.
 *
 * Anchored in design doc §10.
 *
 * This module is the PUBLIC SURFACE only. The implementation lives under
 * `./policy/`, split so each part has one reason to change:
 *
 *   - `policy/errors.ts`       — the diagnostic vocabulary
 *   - `policy/field-checks.ts` — the scalar/shape constraints
 *   - `policy/key-index.ts`    — the by-construction key vocabulary
 *   - `policy/defaults.ts`     — the `_brain.yaml` a fresh vault gets
 *   - `policy/primary-agent.ts`— the agent-id grammar, read and written
 *   - `policy/blocks/*.ts`     — one module per configuration block,
 *                                each owning its defaults, its read-side
 *                                resolver and its parser together
 *   - `policy/validate.ts`     — the block sequence
 *   - `policy/load.ts`         — the disk read and its fallback policy
 */

export { BrainConfigError, type BrainConfigLoadWarning } from "./policy/errors.ts";
export { type BrainConfigKeyIndex } from "./policy/key-index.ts";
export {
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  DEFAULT_BRAIN_CONFIG,
  DERIVED_STORE_MAX_BYTES_DEFAULT,
} from "./policy/defaults.ts";
export { formatPrimaryAgentYamlValue } from "./policy/primary-agent.ts";
export {
  brainConfigKnownKeys,
  validateBrainConfig,
  validateBrainConfigDetailed,
  type ValidateResult,
} from "./policy/validate.ts";
export {
  brainConfigReadFailure,
  brainConfigUnreadableReport,
  loadActiveMostAppliedSafe,
  loadBrainConfig,
  loadBrainConfigDetailed,
  loadFeedbackDefaultScopeSafe,
  loadGuardrailsConfigSafe,
  loadIntegrityConfigSafe,
  loadNotesConfigSafe,
  loadSnapshotDerivedStorePolicySafe,
  loadSnapshotRetentionSafe,
  loadTemporalConfigSafe,
  type BrainDerivedStorePolicy,
  type LoadBrainConfigResult,
} from "./policy/load.ts";

export {
  BRAIN_MOST_APPLIED_DEFAULTS,
  INJECT_BUDGET_CHARS_DEFAULT,
  INJECT_BUDGET_CHARS_MAX,
  INJECT_BUDGET_CHARS_MIN,
  MOST_APPLIED_LIMIT_DEFAULT,
  MOST_APPLIED_LIMIT_MAX,
  MOST_APPLIED_LIMIT_MIN,
  MOST_APPLIED_WINDOW_DAYS_DEFAULT,
  MOST_APPLIED_WINDOW_DAYS_MAX,
  MOST_APPLIED_WINDOW_DAYS_MIN,
  resolveStandingRulesMaxChars,
} from "./policy/blocks/active.ts";
/**
 * The standing-rules cap is declared beside the reader it governs
 * (`standing-rules.ts`) and re-exported here so every `active:` knob is
 * reachable from the one policy surface its neighbours already use.
 */
export {
  STANDING_RULES_MAX_CHARS_DEFAULT,
  STANDING_RULES_MAX_CHARS_MAX,
  STANDING_RULES_MAX_CHARS_MIN,
} from "./standing-rules.ts";
export {
  LESSONS_CORROBORATION_MIN_DEFAULT,
  LESSONS_CORROBORATION_MIN_MAX,
  LESSONS_CORROBORATION_MIN_MIN,
  LESSONS_HALF_LIFE_DAYS_DEFAULT,
  LESSONS_HALF_LIFE_DAYS_MAX,
  LESSONS_HALF_LIFE_DAYS_MIN,
  LESSONS_LIMIT_DEFAULT,
  LESSONS_LIMIT_MAX,
  LESSONS_LIMIT_MIN,
} from "./policy/blocks/lessons.ts";
export {
  BRAIN_GUARDRAIL_DEFAULTS,
  INSTRUCTION_FILE_MAX_LINES_CEILING,
  resolveGuardrails,
} from "./policy/blocks/guardrails.ts";
export {
  BRAIN_INTEGRITY_DEFAULTS,
  BRAIN_INTEGRITY_STRICT_FALLBACK,
  PACK_VALIDITY_SECONDS_DEFAULT,
  resolveIntegrity,
} from "./policy/blocks/integrity.ts";
export { BRAIN_HEALTH_DEFAULTS, resolveHealth } from "./policy/blocks/health.ts";
export { BRAIN_TEMPORAL_DEFAULTS, resolveTemporal } from "./policy/blocks/temporal.ts";
export { BRAIN_LINK_GRAPH_DEFAULTS, resolveLinkGraph } from "./policy/blocks/link-graph.ts";
export { BRAIN_NOTES_DEFAULTS, resolveNotes } from "./policy/blocks/notes.ts";
export { BRAIN_SESSIONS_DEFAULTS, resolveSessions } from "./policy/blocks/sessions.ts";
