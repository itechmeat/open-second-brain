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
 */

import { existsSync, readFileSync } from "node:fs";
import { parseBrainYaml, type ParsedBlock } from "./yaml-parse.ts";

import type {
  BrainActiveConfig,
  BrainAnticipatoryConfig,
  BrainConfig,
  BrainFeedbackConfig,
  BrainGuardrailConfig,
  BrainHealthConfig,
  BrainHygieneConfig,
  BrainLessonsConfig,
  BrainRecallConfig,
  BrainLinkGraphConfig,
  BrainNotesConfig,
  BrainSessionsConfig,
  BrainSchemaConfig,
  BrainMostAppliedConfig,
  BrainTemporalConfig,
  BrainVaultConfig,
  DisciplineReportConfig,
  ResolvedBrainGuardrailConfig,
  ResolvedBrainHealthConfig,
  ResolvedBrainLinkGraphConfig,
  ResolvedBrainNotesConfig,
  ResolvedBrainSessionsConfig,
  ResolvedBrainTemporalConfig,
} from "./types.ts";
import {
  SCHEMA_VOCAB_CATEGORIES,
  SchemaVocabularyError,
  validateSchemaDeclarations,
} from "./schema-vocab.ts";
import { SCOPE_MAX_LEN } from "./signal.ts";
// Imported from `defaults.ts` (not from `vault-scope/index.ts`) to
// break the module-init cycle: the resolver lives in `index.ts` and
// itself imports `loadBrainConfig` from this file. See the
// `defaults.ts` header for the rationale.
import { classifyVaultIgnoreRule, DEFAULT_VAULT_IGNORE_PATHS } from "../vault-scope/defaults.ts";
import { brainConfigPath } from "./paths.ts";

/** Schema versions this build understands. Bump on incompatible changes. */
export const BRAIN_CONFIG_SUPPORTED_VERSIONS: ReadonlyArray<number> = [1];

/**
 * Bounds applied to `active.most_applied.{window_days, limit}` at load
 * time. Values outside these ranges are hard errors — clamping silently
 * would mask the operator's intent.
 */
export const MOST_APPLIED_WINDOW_DAYS_MIN = 1;
export const MOST_APPLIED_WINDOW_DAYS_MAX = 365;
export const MOST_APPLIED_LIMIT_MIN = 1;
export const MOST_APPLIED_LIMIT_MAX = 50;
/** Default window when `_brain.yaml` lacks `active.most_applied.window_days`. */
export const MOST_APPLIED_WINDOW_DAYS_DEFAULT = 30;

/**
 * Character budget for the active.md body injected at SessionStart
 * (token-diet, t_40eb1de7). ~2K tokens - enough for every confirmed
 * rule on a typical vault, small enough that a runaway preference set
 * cannot flood the session preamble. Override via
 * `active.inject_budget_chars`.
 */
export const INJECT_BUDGET_CHARS_DEFAULT = 8000;
export const INJECT_BUDGET_CHARS_MIN = 500;
export const INJECT_BUDGET_CHARS_MAX = 200_000;
/** Default top-N limit when `_brain.yaml` lacks `active.most_applied.limit`. */
export const MOST_APPLIED_LIMIT_DEFAULT = 10;

/**
 * Bounds and defaults for the `lessons:` block (t_62363378) that tunes
 * the signed, recency-scored lessons digest (`Brain/lessons.md`).
 * Out-of-range values are hard errors — an operator-tunable knob must
 * never silently clamp. The half-life default matches the working-memory
 * continuity decay (30 days); the corroboration floor (2 distinct
 * results) keeps a one-off application from promoting straight to
 * `preferred`.
 */
export const LESSONS_HALF_LIFE_DAYS_DEFAULT = 30;
export const LESSONS_HALF_LIFE_DAYS_MIN = 1;
export const LESSONS_HALF_LIFE_DAYS_MAX = 365;
export const LESSONS_CORROBORATION_MIN_DEFAULT = 2;
export const LESSONS_CORROBORATION_MIN_MIN = 1;
export const LESSONS_CORROBORATION_MIN_MAX = 100;
export const LESSONS_LIMIT_DEFAULT = 20;
export const LESSONS_LIMIT_MIN = 1;
export const LESSONS_LIMIT_MAX = 200;

/**
 * Hard upper bound on `guardrails.instruction_file_max_lines`. Any
 * value above this is a misconfiguration - vault-root instruction
 * files are intended to stay small for compliance reasons, so a
 * ceiling like 100000 lines silently disables the warning.
 */
export const INSTRUCTION_FILE_MAX_LINES_CEILING = 10000;

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
  };
}

/**
 * Default `link_graph` block (v0.10.17). Absent from `_brain.yaml`
 * (or with absent individual keys) falls back here via
 * `resolveLinkGraph`. Both knobs are purely structural - no
 * vocabulary detection of "this looks like a MOC".
 *
 * Defaults:
 *   - `moc_min_outbound_links: 5` - the heuristic floor for "this
 *     is a hub note", chosen to filter out prose notes with a few
 *     inline references.
 *   - `moc_min_link_ratio: 0.3` - 30 % of the body's non-whitespace
 *     characters must sit inside `[[…]]` for the audit to accept
 *     the note as a MOC. Prose notes typically score below 0.1.
 *   - `vault_instruction_file: "VAULT.md"` - the user-authored
 *     vault-root instruction file `brain_context` surfaces when
 *     present. Configurable per vault.
 */
export const BRAIN_LINK_GRAPH_DEFAULTS: ResolvedBrainLinkGraphConfig = Object.freeze({
  moc_min_outbound_links: 5,
  moc_min_link_ratio: 0.3,
  vault_instruction_file: "VAULT.md",
}) as ResolvedBrainLinkGraphConfig;

/**
 * Merge a parsed `link_graph` block (or `undefined`) with
 * `BRAIN_LINK_GRAPH_DEFAULTS`.
 */
export function resolveLinkGraph(cfg: BrainConfig): ResolvedBrainLinkGraphConfig {
  const lg = cfg.link_graph;
  if (lg === undefined) return BRAIN_LINK_GRAPH_DEFAULTS;
  return {
    moc_min_outbound_links:
      lg.moc_min_outbound_links ?? BRAIN_LINK_GRAPH_DEFAULTS.moc_min_outbound_links,
    moc_min_link_ratio: lg.moc_min_link_ratio ?? BRAIN_LINK_GRAPH_DEFAULTS.moc_min_link_ratio,
    vault_instruction_file:
      lg.vault_instruction_file ?? BRAIN_LINK_GRAPH_DEFAULTS.vault_instruction_file,
  };
}

/**
 * Default `temporal:` block (v0.10.18). Drives the temporal +
 * synthesis subsystem. Absent block falls back here via
 * `resolveTemporal`. All knobs are purely structural:
 *
 *   - `stale_pref_days: 90` - 3 months without activity before a
 *     preference is reported as stale.
 *   - `stale_signal_days: 30` - 1 month without activity for signals.
 *   - `stale_log_days: 180` - 6 months for Brain/log files.
 *   - `weekly_start_dow: 1` - ISO-8601 weekday number (1 = Monday,
 *     7 = Sunday). Configurable for vaults that prefer Sunday-start
 *     weeks without any language-specific detection.
 *   - `daily_window_offset_hours: 0` - daily-brief windows align
 *     with UTC midnight by default.
 */
export const BRAIN_TEMPORAL_DEFAULTS: ResolvedBrainTemporalConfig = Object.freeze({
  stale_pref_days: 90,
  stale_signal_days: 30,
  stale_log_days: 180,
  weekly_start_dow: 1,
  daily_window_offset_hours: 0,
}) as ResolvedBrainTemporalConfig;

/**
 * Merge a parsed `temporal` block (or `undefined`) with
 * `BRAIN_TEMPORAL_DEFAULTS`.
 */
export function resolveTemporal(cfg: BrainConfig): ResolvedBrainTemporalConfig {
  const tp = cfg.temporal;
  if (tp === undefined) return BRAIN_TEMPORAL_DEFAULTS;
  return {
    stale_pref_days: tp.stale_pref_days ?? BRAIN_TEMPORAL_DEFAULTS.stale_pref_days,
    stale_signal_days: tp.stale_signal_days ?? BRAIN_TEMPORAL_DEFAULTS.stale_signal_days,
    stale_log_days: tp.stale_log_days ?? BRAIN_TEMPORAL_DEFAULTS.stale_log_days,
    weekly_start_dow: tp.weekly_start_dow ?? BRAIN_TEMPORAL_DEFAULTS.weekly_start_dow,
    daily_window_offset_hours:
      tp.daily_window_offset_hours ?? BRAIN_TEMPORAL_DEFAULTS.daily_window_offset_hours,
  };
}

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
  };
}

/**
 * Default `notes:` block (v0.11.0). Empty `read_paths` list means
 * the agent does not scan any user-authored notes. The operator
 * opts in by listing folders in `_brain.yaml`.
 */
export const BRAIN_NOTES_DEFAULTS: ResolvedBrainNotesConfig = Object.freeze({
  read_paths: Object.freeze([]) as ReadonlyArray<string>,
}) as ResolvedBrainNotesConfig;

/**
 * Merge a parsed `notes` block (or `undefined`) with
 * `BRAIN_NOTES_DEFAULTS`. The resulting struct (and its inner array)
 * are frozen so consumers can pass the slice around without copying.
 */
export function resolveNotes(cfg: BrainConfig): ResolvedBrainNotesConfig {
  const block = cfg.notes;
  if (block === undefined || block.read_paths === undefined) {
    return BRAIN_NOTES_DEFAULTS;
  }
  return Object.freeze({
    read_paths: Object.freeze([...block.read_paths]) as ReadonlyArray<string>,
  }) as ResolvedBrainNotesConfig;
}

/**
 * Default `sessions:` block (Memory Integrity Suite). Empty lists
 * mean every session and message is captured - the pre-boundary
 * behaviour, bit-identical.
 */
export const BRAIN_SESSIONS_DEFAULTS: ResolvedBrainSessionsConfig = Object.freeze({
  ignore_patterns: Object.freeze([]) as ReadonlyArray<string>,
  stateless_patterns: Object.freeze([]) as ReadonlyArray<string>,
  ignore_message_patterns: Object.freeze([]) as ReadonlyArray<string>,
}) as ResolvedBrainSessionsConfig;

/** Merge a parsed `sessions` block (or `undefined`) with the defaults. */
export function resolveSessions(cfg: BrainConfig): ResolvedBrainSessionsConfig {
  const block = cfg.sessions;
  if (block === undefined) return BRAIN_SESSIONS_DEFAULTS;
  return Object.freeze({
    ignore_patterns: Object.freeze([...(block.ignore_patterns ?? [])]) as ReadonlyArray<string>,
    stateless_patterns: Object.freeze([
      ...(block.stateless_patterns ?? []),
    ]) as ReadonlyArray<string>,
    ignore_message_patterns: Object.freeze([
      ...(block.ignore_message_patterns ?? []),
    ]) as ReadonlyArray<string>,
  }) as ResolvedBrainSessionsConfig;
}

/**
 * Factory for the "load + resolve a block, fall back to its defaults on
 * ANY failure" pattern repeated at every `load*ConfigSafe` below (missing
 * `_brain.yaml`, malformed YAML, or a validation error all collapse to
 * the same fallback - these are read surfaces for vaults that may not
 * have run `brain init` yet, not strict config consumers).
 */
function makeSafeLoader<T>(
  resolveFn: (config: BrainConfig) => T,
  fallback: T,
): (vault: string) => T {
  return (vault: string): T => {
    try {
      return resolveFn(loadBrainConfig(vault));
    } catch {
      return fallback;
    }
  };
}

/**
 * Load + resolve the `notes:` block, falling back to
 * `BRAIN_NOTES_DEFAULTS` when the config file is missing, malformed,
 * or otherwise unreadable. Same pattern as `loadTemporalConfigSafe`.
 * Used by `scan-inline` and any future scanner so a freshly-cloned
 * vault that has not been `brain init`-ed still produces a clean
 * "no user folders to read" result.
 */
export const loadNotesConfigSafe = makeSafeLoader(resolveNotes, BRAIN_NOTES_DEFAULTS);

/**
 * Load + resolve the `temporal:` block, falling back to
 * `BRAIN_TEMPORAL_DEFAULTS` when the config file is missing,
 * malformed, or otherwise unreadable. Used by every temporal
 * consumer (MCP wrappers, CLI verbs) so a freshly-initialised vault
 * still produces a useful report.
 */
export const loadTemporalConfigSafe = makeSafeLoader(resolveTemporal, BRAIN_TEMPORAL_DEFAULTS);

/**
 * Load + resolve the `guardrails:` block, falling back to
 * `BRAIN_GUARDRAIL_DEFAULTS` when the config file is missing, malformed,
 * or otherwise unreadable. Used by agent-facing surfaces (e.g. the
 * context pack) that must work on a vault without a full `brain init`;
 * the opt-in toggles therefore default off rather than throwing.
 */
export const loadGuardrailsConfigSafe = makeSafeLoader(resolveGuardrails, BRAIN_GUARDRAIL_DEFAULTS);

/**
 * Load the configured `feedback.default_scope`, or `undefined` when the
 * config file is missing, malformed, or carries no feedback block. Used
 * by the feedback write surfaces so a vault without a full `brain init`
 * stays scope-less (byte-identical to pre-feature behaviour) instead of
 * throwing when the signal is recorded.
 */
export const loadFeedbackDefaultScopeSafe = makeSafeLoader(
  (config: BrainConfig) => config.feedback?.default_scope,
  undefined as string | undefined,
);

/**
 * Default `_brain.yaml` content. Mirrors §10 of the design doc. Used by
 * `brain init` and as the fallback inside `loadBrainConfig` when callers
 * opt into permissive mode (the current API is strict — absent file
 * throws).
 */
export const DEFAULT_BRAIN_CONFIG: BrainConfig = Object.freeze({
  schema_version: 1,
  primary_agent: null,
  dream: Object.freeze({
    candidate_threshold: 3,
    unconfirmed_window_days: 14,
    contradiction_window_days: 14,
    heal_enrich_enabled: false,
  }),
  retire: Object.freeze({
    stale_evidence_days: 90,
  }),
  confidence: Object.freeze({
    low_max_applied: 2,
    medium_min: 0.4,
    high_min: 0.75,
  }),
  snapshots: Object.freeze({
    retention_count: 10,
  }),
  vault: Object.freeze({
    ignore_paths: DEFAULT_VAULT_IGNORE_PATHS,
  }),
}) as BrainConfig;

/**
 * Serialised default `_brain.yaml`. Hand-formatted to match the design
 * doc verbatim — `brain init` writes this byte string so the file the
 * user sees is the file the docs describe.
 */
export const DEFAULT_BRAIN_CONFIG_YAML = `schema_version: 1

# Optional. When set, dream runs from a different agent emit a stderr
# warning and a non_primary_agent payload row. The vault should have a
# single dream-running runtime even when it is shared across devices
# via Syncthing.
primary_agent: null

dream:
  candidate_threshold: 3
  unconfirmed_window_days: 14
  contradiction_window_days: 14

retire:
  stale_evidence_days: 90

confidence:
  # low_max_applied gates the "low-evidence-confirmed" doctor warning
  # and the auto-promotion of unconfirmed preferences to confirmed.
  low_max_applied: 2
  # Band thresholds on the numeric confidence_value (Wilson lower
  # bound times freshness decay). value >= high_min ⇒ high;
  # value >= medium_min ⇒ medium; else low.
  medium_min: 0.40
  high_min: 0.75

snapshots:
  retention_count: 10

# Vault-wide exclusion policy. Single source of truth for every
# vault walker (search indexer, scan-inline, future scanners).
# Entries without a slash match a directory name anywhere in the
# tree; entries with a slash match a vault-relative POSIX path
# exactly. Remove the block to fall back to the built-in defaults;
# set ignore_paths to an empty list to disable exclusions entirely.
vault:
  ignore_paths:
    - .git
    - node_modules
    - .open-second-brain
    - .obsidian
    - .trash
    - .stversions
    - Brain/.snapshots
`;

const YAML_STRING_REJECTED_CHARS = ['"', "\\", "\n", "\r"] as const;

/**
 * Format a `primary_agent` value for the small `_brain.yaml` subset.
 *
 * We quote non-null values so spaces / `#` / `:` round-trip as data
 * instead of being interpreted as comments or YAML structure. Since the
 * parser intentionally does not implement escape sequences, reject bytes
 * that would require escaping rather than writing a value that cannot
 * be read back exactly.
 */
export function formatPrimaryAgentYamlValue(
  value: string | null,
  source: string | null = null,
): string {
  if (value === null) return "null";
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError(
      "must be either null or a non-empty string",
      "primary_agent",
      source,
    );
  }
  for (const bad of YAML_STRING_REJECTED_CHARS) {
    if (trimmed.includes(bad)) {
      throw new BrainConfigError(
        `contains a disallowed character ${JSON.stringify(bad)}; ` +
          "use a simple one-line agent id",
        "primary_agent",
        source,
      );
    }
  }
  return `"${trimmed}"`;
}

/**
 * Warnings collected during validation. Forward-compat tolerates unknown
 * top-level keys but surfaces them so a typo doesn't go unnoticed.
 */
export interface BrainConfigLoadWarning {
  readonly path: string;
  readonly message: string;
}

export class BrainConfigError extends Error {
  /**
   * Dotted field path that caused the failure (`dream.candidate_threshold`,
   * `schema_version`, …). `null` for top-level type errors.
   */
  readonly field: string | null;
  readonly source: string | null;

  constructor(message: string, field: string | null, source: string | null) {
    super(
      field
        ? `${source ?? "<config>"}: ${field}: ${message}`
        : `${source ?? "<config>"}: ${message}`,
    );
    this.name = "BrainConfigError";
    this.field = field;
    this.source = source;
  }
}

// ----- Public API -----------------------------------------------------------

export interface LoadBrainConfigResult {
  readonly config: BrainConfig;
  readonly warnings: ReadonlyArray<BrainConfigLoadWarning>;
  readonly path: string;
}

/**
 * Read and validate `<vault>/Brain/_brain.yaml`.
 *
 * Throws {@link BrainConfigError} on:
 *   - missing file
 *   - YAML shape errors
 *   - unsupported `schema_version`
 *   - non-integer / out-of-range thresholds
 *   - non-integer / non-positive `snapshots.retention_count`
 *
 * Unknown top-level keys are reported as warnings, not errors.
 */
export function loadBrainConfig(vault: string): BrainConfig {
  return loadBrainConfigDetailed(vault).config;
}

/**
 * Same as {@link loadBrainConfig} but also returns parser warnings (for
 * the future `o2b brain doctor` integration).
 */
export function loadBrainConfigDetailed(vault: string): LoadBrainConfigResult {
  const path = brainConfigPath(vault);
  if (!existsSync(path)) {
    throw new BrainConfigError(
      "config file does not exist; run `o2b brain init` first",
      null,
      path,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new BrainConfigError(
      `failed to read: ${(err as Error).message ?? String(err)}`,
      null,
      path,
    );
  }

  let parsed: ParsedBlock;
  try {
    parsed = parseBrainYaml(text);
  } catch (err) {
    throw new BrainConfigError((err as Error).message, null, path);
  }

  const { config, warnings } = validateBrainConfigDetailed(parsed, path);
  return { config, warnings, path };
}

/**
 * Pure validator. Accepts a parsed object (typically from
 * {@link parseBrainYaml}) and returns a typed {@link BrainConfig}, or
 * throws {@link BrainConfigError} naming the offending field.
 *
 * `source` is rendered into error messages; pass the config file path or
 * a synthetic label like `"<test fixture>"` so the failure points at
 * something useful.
 */
export function validateBrainConfig(parsed: unknown, source: string | null = null): BrainConfig {
  return validateBrainConfigDetailed(parsed, source).config;
}

export interface ValidateResult {
  readonly config: BrainConfig;
  readonly warnings: ReadonlyArray<BrainConfigLoadWarning>;
}

export function validateBrainConfigDetailed(
  parsed: unknown,
  source: string | null = null,
): ValidateResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BrainConfigError("config root must be a map of keys", null, source);
  }
  const obj = parsed as Record<string, unknown>;
  const warnings: BrainConfigLoadWarning[] = [];
  // Populated by every `hasBlock`/`mergeBlock` call below; drives the
  // forward-compat "unknown top-level field" check at the end of this
  // function. `schema_version` is seeded directly since its presence is
  // checked by an inverted `if (!(... in obj))` immediately below, not
  // through either helper.
  const knownBlockKeys = new Set<string>(["schema_version"]);

  // schema_version is mandatory and must be in the supported set.
  if (!("schema_version" in obj)) {
    throw new BrainConfigError(
      "missing required field; expected a positive integer in the supported set " +
        `(${BRAIN_CONFIG_SUPPORTED_VERSIONS.join(", ")})`,
      "schema_version",
      source,
    );
  }
  const schemaVersion = obj["schema_version"];
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    !BRAIN_CONFIG_SUPPORTED_VERSIONS.includes(schemaVersion)
  ) {
    throw new BrainConfigError(
      `unsupported value ${JSON.stringify(schemaVersion)}; expected one of ` +
        BRAIN_CONFIG_SUPPORTED_VERSIONS.join(", "),
      "schema_version",
      source,
    );
  }

  // `primary_agent` — optional scalar (null or non-empty string).
  // Defaults to null when absent so existing vaults are unaffected.
  // Loader enforces the same character constraints as the writer
  // (`formatPrimaryAgentYamlValue`) so a hand-edited file that the
  // writer would later refuse to emit fails fast at load time
  // instead of round-tripping into a state we cannot persist.
  let primaryAgent: string | null = DEFAULT_BRAIN_CONFIG.primary_agent;
  if (hasBlock(obj, "primary_agent", knownBlockKeys)) {
    const v = obj["primary_agent"];
    if (v === null || v === undefined) {
      primaryAgent = null;
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length === 0) {
        throw new BrainConfigError(
          "must be either null or a non-empty string",
          "primary_agent",
          source,
        );
      }
      for (const bad of YAML_STRING_REJECTED_CHARS) {
        if (trimmed.includes(bad)) {
          throw new BrainConfigError(
            `contains a disallowed character ${JSON.stringify(bad)}; ` +
              "use a simple one-line agent id",
            "primary_agent",
            source,
          );
        }
      }
      primaryAgent = trimmed;
    } else {
      throw new BrainConfigError(
        `must be either null or a non-empty string; got ${describe(v)}`,
        "primary_agent",
        source,
      );
    }
  }

  // Each block is optional; missing blocks inherit the default. We
  // merge field-by-field so a user can override one threshold without
  // having to re-state the rest.
  const dream = mergeBlock(
    "dream",
    obj["dream"],
    DEFAULT_BRAIN_CONFIG.dream as unknown as Readonly<Record<string, number>>,
    source,
    knownBlockKeys,
  );
  requirePositiveInteger("dream.candidate_threshold", dream.candidate_threshold, source);
  requirePositiveInteger("dream.unconfirmed_window_days", dream.unconfirmed_window_days, source);
  requirePositiveInteger(
    "dream.contradiction_window_days",
    dream.contradiction_window_days,
    source,
  );

  const retire = mergeBlock(
    "retire",
    obj["retire"],
    DEFAULT_BRAIN_CONFIG.retire as unknown as Readonly<Record<string, number>>,
    source,
    knownBlockKeys,
  );
  requirePositiveInteger("retire.stale_evidence_days", retire.stale_evidence_days, source);

  const confidence = mergeBlock(
    "confidence",
    obj["confidence"],
    DEFAULT_BRAIN_CONFIG.confidence as unknown as Readonly<Record<string, number>>,
    source,
    knownBlockKeys,
  );
  requireNonNegativeInteger("confidence.low_max_applied", confidence.low_max_applied, source);
  requireUnitInterval("confidence.medium_min", confidence.medium_min, source);
  requireUnitInterval("confidence.high_min", confidence.high_min, source);
  if ((confidence.medium_min as number) >= (confidence.high_min as number)) {
    throw new BrainConfigError(
      `medium_min must be strictly less than high_min; got ` +
        `medium_min=${confidence.medium_min}, high_min=${confidence.high_min}`,
      "confidence.medium_min",
      source,
    );
  }

  const snapshots = mergeBlock(
    "snapshots",
    obj["snapshots"],
    DEFAULT_BRAIN_CONFIG.snapshots as unknown as Readonly<Record<string, number>>,
    source,
    knownBlockKeys,
  );
  requirePositiveInteger("snapshots.retention_count", snapshots.retention_count, source);

  // Optional `vault` block (v0.10.9). Hard-error on shape problems —
  // exclusions affect every walker, silent ignore would be a footgun.
  // The block is absent for vaults created before v0.10.9 and for
  // operators who explicitly removed it; the resolver falls back to
  // `DEFAULT_VAULT_IGNORE_PATHS` in both cases.
  let vault: BrainVaultConfig | undefined;
  if (hasBlock(obj, "vault", knownBlockKeys)) {
    const raw = obj["vault"];
    const rawMap = requireMapBlock(raw, "vault", source);
    if ("ignore_paths" in rawMap) {
      const list = rawMap["ignore_paths"];
      if (!Array.isArray(list)) {
        throw new BrainConfigError(
          `must be a list of strings; got ${describe(list)}`,
          "vault.ignore_paths",
          source,
        );
      }
      const validated: string[] = [];
      list.forEach((entry, i) => {
        if (typeof entry !== "string") {
          throw new BrainConfigError(
            `must be a string; got ${describe(entry)}`,
            `vault.ignore_paths[${i}]`,
            source,
          );
        }
        const trimmed = entry.trim();
        if (trimmed.length === 0) {
          throw new BrainConfigError(
            "must be a non-empty string",
            `vault.ignore_paths[${i}]`,
            source,
          );
        }
        for (const bad of YAML_STRING_REJECTED_CHARS) {
          if (trimmed.includes(bad)) {
            throw new BrainConfigError(
              `contains a disallowed character ${JSON.stringify(bad)}; ` +
                "use a simple one-line path",
              `vault.ignore_paths[${i}]`,
              source,
            );
          }
        }
        // `classifyVaultIgnoreRule` strips leading `./` / trailing
        // `/` / collapsing `//`. An entry that normalises to the
        // empty string (`./`, `/`, `///`) would silently disable
        // itself; reject so the operator sees the typo immediately.
        const normalised = classifyVaultIgnoreRule(trimmed).raw;
        if (normalised.length === 0) {
          throw new BrainConfigError(
            "normalises to the empty string; use a real directory name or vault-relative path",
            `vault.ignore_paths[${i}]`,
            source,
          );
        }
        // Reject leading-slash entries explicitly. `matchIgnore` only
        // compares vault-relative POSIX prefixes (no leading `/`), so
        // `/Brain/.snapshots` would silently never match — exactly the
        // fail-closed contract violation the v0.10.9 policy forbids.
        if (normalised.startsWith("/")) {
          throw new BrainConfigError(
            "must be a bare name or vault-relative POSIX path without a leading '/'",
            `vault.ignore_paths[${i}]`,
            source,
          );
        }
        validated.push(normalised);
      });
      vault = { ignore_paths: Object.freeze(validated) };
    }
    // Forward-compat: unknown sub-keys under `vault:` → warning.
    warnUnknownKeys(rawMap, ["ignore_paths"], "vault", source, warnings);
  }

  // Optional `active.{most_applied_window_days, most_applied_limit}`
  // block (v0.10.11). Hard-error on shape problems — operator-tunable
  // knobs should never silently fall back to defaults.
  //
  // The YAML keys are flat at level 2 to fit the existing two-level
  // parser; the in-memory shape `BrainActiveConfig.most_applied` still
  // groups them so downstream consumers (`active.md`, `brain_digest`)
  // can pass one struct around.
  let active: BrainActiveConfig | undefined;
  if (hasBlock(obj, "active", knownBlockKeys)) {
    const rawActive = obj["active"];
    const activeMap = requireMapBlock(rawActive, "active", source);
    const hasWindow = "most_applied_window_days" in activeMap;
    const hasLimit = "most_applied_limit" in activeMap;
    let mostApplied: BrainMostAppliedConfig | undefined;
    if (hasWindow || hasLimit) {
      const windowDays = hasWindow
        ? activeMap["most_applied_window_days"]
        : MOST_APPLIED_WINDOW_DAYS_DEFAULT;
      const limit = hasLimit ? activeMap["most_applied_limit"] : MOST_APPLIED_LIMIT_DEFAULT;
      if (
        typeof windowDays !== "number" ||
        !Number.isInteger(windowDays) ||
        windowDays < MOST_APPLIED_WINDOW_DAYS_MIN ||
        windowDays > MOST_APPLIED_WINDOW_DAYS_MAX
      ) {
        throw new BrainConfigError(
          `must be an integer between ${MOST_APPLIED_WINDOW_DAYS_MIN} and ` +
            `${MOST_APPLIED_WINDOW_DAYS_MAX}; got ${describe(windowDays)}`,
          "active.most_applied_window_days",
          source,
        );
      }
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < MOST_APPLIED_LIMIT_MIN ||
        limit > MOST_APPLIED_LIMIT_MAX
      ) {
        throw new BrainConfigError(
          `must be an integer between ${MOST_APPLIED_LIMIT_MIN} and ` +
            `${MOST_APPLIED_LIMIT_MAX}; got ${describe(limit)}`,
          "active.most_applied_limit",
          source,
        );
      }
      mostApplied = { window_days: windowDays, limit };
    }
    let injectBudgetChars: number | undefined;
    if ("inject_budget_chars" in activeMap) {
      const raw = activeMap["inject_budget_chars"];
      if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw < INJECT_BUDGET_CHARS_MIN ||
        raw > INJECT_BUDGET_CHARS_MAX
      ) {
        throw new BrainConfigError(
          `must be an integer between ${INJECT_BUDGET_CHARS_MIN} and ` +
            `${INJECT_BUDGET_CHARS_MAX}; got ${describe(raw)}`,
          "active.inject_budget_chars",
          source,
        );
      }
      injectBudgetChars = raw;
    }
    // Forward-compat: unknown sub-keys under `active:` → warning.
    warnUnknownKeys(
      activeMap,
      ["most_applied_window_days", "most_applied_limit", "inject_budget_chars"],
      "active",
      source,
      warnings,
    );
    active = {
      ...(mostApplied !== undefined ? { most_applied: mostApplied } : {}),
      ...(injectBudgetChars !== undefined ? { inject_budget_chars: injectBudgetChars } : {}),
    };
  }

  // Optional `lessons:` block (t_62363378). Tunes the signed,
  // recency-scored lessons digest. Hard-error on out-of-range values —
  // operator-tunable knobs must never silently fall back to defaults.
  let lessons: BrainLessonsConfig | undefined;
  if (hasBlock(obj, "lessons", knownBlockKeys)) {
    const rawLessons = obj["lessons"];
    const lessonsMap = requireMapBlock(rawLessons, "lessons", source);
    const halfLife = readBoundedInt(
      lessonsMap,
      "half_life_days",
      LESSONS_HALF_LIFE_DAYS_MIN,
      LESSONS_HALF_LIFE_DAYS_MAX,
      source,
    );
    const corroborationMin = readBoundedInt(
      lessonsMap,
      "corroboration_min",
      LESSONS_CORROBORATION_MIN_MIN,
      LESSONS_CORROBORATION_MIN_MAX,
      source,
    );
    const lessonsLimit = readBoundedInt(
      lessonsMap,
      "limit",
      LESSONS_LIMIT_MIN,
      LESSONS_LIMIT_MAX,
      source,
    );
    warnUnknownKeys(
      lessonsMap,
      ["half_life_days", "corroboration_min", "limit"],
      "lessons",
      source,
      warnings,
    );
    lessons = {
      ...(halfLife !== undefined ? { half_life_days: halfLife } : {}),
      ...(corroborationMin !== undefined ? { corroboration_min: corroborationMin } : {}),
      ...(lessonsLimit !== undefined ? { limit: lessonsLimit } : {}),
    };
  }

  // Optional `discipline_report` section. On any type mismatch, emit a
  // warning and drop the section (return undefined) rather than throwing —
  // the rest of the CLI surface must keep working.
  let disciplineReport: DisciplineReportConfig | undefined;
  if (hasBlock(obj, "discipline_report", knownBlockKeys)) {
    const dr = obj["discipline_report"];
    if (typeof dr !== "object" || dr === null || Array.isArray(dr)) {
      warnings.push({
        path: source ?? "<config>",
        message: `discipline_report: must be a map of keys; got ${describe(dr)} — section ignored`,
      });
    } else {
      const drObj = dr as Record<string, unknown>;
      let ok = true;

      // enabled: boolean
      if (typeof drObj["enabled"] !== "boolean") {
        warnings.push({
          path: source ?? "<config>",
          message: `discipline_report.enabled: must be a boolean; got ${describe(drObj["enabled"])} — section ignored`,
        });
        ok = false;
      }

      // timezone: string
      if (typeof drObj["timezone"] !== "string") {
        warnings.push({
          path: source ?? "<config>",
          message: `discipline_report.timezone: must be a string; got ${describe(drObj["timezone"])} — section ignored`,
        });
        ok = false;
      }

      // watched_paths: array of strings
      if (!Array.isArray(drObj["watched_paths"])) {
        warnings.push({
          path: source ?? "<config>",
          message: `discipline_report.watched_paths: must be an array; got ${describe(drObj["watched_paths"])} — section ignored`,
        });
        ok = false;
      } else {
        const badIdx = (drObj["watched_paths"] as unknown[]).findIndex(
          (v) => typeof v !== "string",
        );
        if (badIdx >= 0) {
          warnings.push({
            path: source ?? "<config>",
            message: `discipline_report.watched_paths[${badIdx}]: must be a string; got ${describe((drObj["watched_paths"] as unknown[])[badIdx])} — section ignored`,
          });
          ok = false;
        }
      }

      // known_agents: array of strings
      if (!Array.isArray(drObj["known_agents"])) {
        warnings.push({
          path: source ?? "<config>",
          message: `discipline_report.known_agents: must be an array; got ${describe(drObj["known_agents"])} — section ignored`,
        });
        ok = false;
      } else {
        const badIdx = (drObj["known_agents"] as unknown[]).findIndex((v) => typeof v !== "string");
        if (badIdx >= 0) {
          warnings.push({
            path: source ?? "<config>",
            message: `discipline_report.known_agents[${badIdx}]: must be a string; got ${describe((drObj["known_agents"] as unknown[])[badIdx])} — section ignored`,
          });
          ok = false;
        }
      }

      if (ok) {
        disciplineReport = {
          enabled: drObj["enabled"] as boolean,
          timezone: drObj["timezone"] as string,
          watched_paths: drObj["watched_paths"] as ReadonlyArray<string>,
          known_agents: drObj["known_agents"] as ReadonlyArray<string>,
        };
      }
    }
  }

  // Optional `guardrails` block (v0.10.16). Hard-error on shape
  // problems - thresholds are operator-tunable and silent fallback
  // would mask the operator's intent. Missing block leaves
  // `cfg.guardrails` undefined; `resolveGuardrails` injects defaults
  // on the read side so consumers receive a fully-populated struct.
  let guardrails: BrainGuardrailConfig | undefined;
  if (hasBlock(obj, "guardrails", knownBlockKeys)) {
    const raw = obj["guardrails"];
    const rawMap = requireMapBlock(raw, "guardrails", source);
    const partial: {
      promotion_min_signals?: number;
      promotion_min_distinct_agents?: number;
      promotion_min_age_days?: number;
      instruction_file_max_lines?: number;
      untrusted_source_delimiting?: boolean;
      derived_fact_synthesis?: boolean;
      provenance_trust_ordering?: boolean;
      owner_scoped_facts?: boolean;
      marker_writeback?: boolean;
    } = {};

    if ("promotion_min_signals" in rawMap) {
      requirePositiveInteger(
        "guardrails.promotion_min_signals",
        rawMap["promotion_min_signals"],
        source,
      );
      partial.promotion_min_signals = rawMap["promotion_min_signals"] as number;
    }
    if ("promotion_min_distinct_agents" in rawMap) {
      requirePositiveInteger(
        "guardrails.promotion_min_distinct_agents",
        rawMap["promotion_min_distinct_agents"],
        source,
      );
      partial.promotion_min_distinct_agents = rawMap["promotion_min_distinct_agents"] as number;
    }
    if ("promotion_min_age_days" in rawMap) {
      requireNonNegativeInteger(
        "guardrails.promotion_min_age_days",
        rawMap["promotion_min_age_days"],
        source,
      );
      partial.promotion_min_age_days = rawMap["promotion_min_age_days"] as number;
    }
    if ("instruction_file_max_lines" in rawMap) {
      requirePositiveInteger(
        "guardrails.instruction_file_max_lines",
        rawMap["instruction_file_max_lines"],
        source,
      );
      const v = rawMap["instruction_file_max_lines"] as number;
      if (v > INSTRUCTION_FILE_MAX_LINES_CEILING) {
        throw new BrainConfigError(
          `must be at most ${INSTRUCTION_FILE_MAX_LINES_CEILING}; got ${describe(v)}`,
          "guardrails.instruction_file_max_lines",
          source,
        );
      }
      partial.instruction_file_max_lines = v;
    }
    if ("untrusted_source_delimiting" in rawMap) {
      const flag = rawMap["untrusted_source_delimiting"];
      if (typeof flag !== "boolean") {
        throw new BrainConfigError(
          `must be a boolean; got ${describe(flag)}`,
          "guardrails.untrusted_source_delimiting",
          source,
        );
      }
      partial.untrusted_source_delimiting = flag;
    }
    // Knowledge Provenance opt-in boolean flags (v1.7). Same shape as
    // untrusted_source_delimiting: present → must be boolean, else hard error.
    for (const key of [
      "derived_fact_synthesis",
      "provenance_trust_ordering",
      "owner_scoped_facts",
      "marker_writeback",
    ] as const) {
      if (key in rawMap) {
        const flag = rawMap[key];
        if (typeof flag !== "boolean") {
          throw new BrainConfigError(
            `must be a boolean; got ${describe(flag)}`,
            `guardrails.${key}`,
            source,
          );
        }
        partial[key] = flag;
      }
    }

    // Forward-compat: unknown sub-keys under `guardrails:` → warning.
    warnUnknownKeys(
      rawMap,
      [
        "promotion_min_signals",
        "promotion_min_distinct_agents",
        "promotion_min_age_days",
        "instruction_file_max_lines",
        "untrusted_source_delimiting",
        "derived_fact_synthesis",
        "provenance_trust_ordering",
        "owner_scoped_facts",
        "marker_writeback",
      ],
      "guardrails",
      source,
      warnings,
    );

    if (Object.keys(partial).length > 0) {
      guardrails = partial;
    } else {
      // Block present but contained only unknown fields: keep an
      // empty marker so `cfg.guardrails` is non-undefined and
      // distinguishable from "block absent entirely".
      guardrails = {};
    }
  }

  // Optional `link_graph` block (v0.10.17). Shape:
  //   link_graph:
  //     moc_min_outbound_links: 5     # positive integer
  //     moc_min_link_ratio: 0.3       # number in (0, 1]
  //     vault_instruction_file: VAULT.md  # vault-relative path
  // Absent block → `cfg.link_graph` undefined; resolveLinkGraph
  // returns the bit-identical defaults.
  let linkGraph: BrainLinkGraphConfig | undefined;
  if (hasBlock(obj, "link_graph", knownBlockKeys)) {
    const rawLg = obj["link_graph"];
    const lgObj = requireMapBlock(rawLg, "link_graph", source);
    const partialLg: Record<string, unknown> = {};
    if ("moc_min_outbound_links" in lgObj) {
      const v = lgObj["moc_min_outbound_links"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        throw new BrainConfigError(
          "must be a positive integer",
          "link_graph.moc_min_outbound_links",
          source,
        );
      }
      partialLg["moc_min_outbound_links"] = v;
    }
    if ("moc_min_link_ratio" in lgObj) {
      const v = lgObj["moc_min_link_ratio"];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) {
        throw new BrainConfigError(
          "must be a number in (0, 1]",
          "link_graph.moc_min_link_ratio",
          source,
        );
      }
      partialLg["moc_min_link_ratio"] = v;
    }
    if ("vault_instruction_file" in lgObj) {
      const v = lgObj["vault_instruction_file"];
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new BrainConfigError(
          "must be a non-empty string",
          "link_graph.vault_instruction_file",
          source,
        );
      }
      // Trim BEFORE the path-shape check so a value like
      // `" VAULT.md "` doesn't survive validation and fail at
      // read time as a missing file.
      const trimmed = v.trim();
      // Reject absolute paths and `..` traversal at load time so
      // the config surface fails loudly instead of silently
      // omitting the envelope field at read time.
      if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.includes("..")) {
        throw new BrainConfigError(
          "must be a vault-relative path without '..' segments",
          "link_graph.vault_instruction_file",
          source,
        );
      }
      partialLg["vault_instruction_file"] = trimmed;
    }
    // Forward-compat: unknown sub-keys under `link_graph:` → warning.
    warnUnknownKeys(
      lgObj,
      ["moc_min_outbound_links", "moc_min_link_ratio", "vault_instruction_file"],
      "link_graph",
      source,
      warnings,
    );
    linkGraph = Object.keys(partialLg).length > 0 ? (partialLg as BrainLinkGraphConfig) : {};
  }

  // Optional `temporal` block (v0.10.18). Shape:
  //   temporal:
  //     stale_pref_days: 90              # positive integer
  //     stale_signal_days: 30            # positive integer
  //     stale_log_days: 180              # positive integer
  //     weekly_start_dow: 1              # 1..7 (ISO-8601 weekday)
  //     daily_window_offset_hours: 0     # -23..23
  // Absent block → `cfg.temporal` undefined; resolveTemporal returns
  // the bit-identical defaults.
  let temporal: BrainTemporalConfig | undefined;
  if (hasBlock(obj, "temporal", knownBlockKeys)) {
    const rawTp = obj["temporal"];
    const tpObj = requireMapBlock(rawTp, "temporal", source);
    const partialTp: Record<string, unknown> = {};
    const positiveIntKeys: ReadonlyArray<
      "stale_pref_days" | "stale_signal_days" | "stale_log_days"
    > = ["stale_pref_days", "stale_signal_days", "stale_log_days"];
    for (const key of positiveIntKeys) {
      if (key in tpObj) {
        const v = tpObj[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
          throw new BrainConfigError("must be a positive integer", `temporal.${key}`, source);
        }
        partialTp[key] = v;
      }
    }
    if ("weekly_start_dow" in tpObj) {
      const v = tpObj["weekly_start_dow"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 7) {
        throw new BrainConfigError(
          "must be an ISO-8601 weekday number (1..7)",
          "temporal.weekly_start_dow",
          source,
        );
      }
      partialTp["weekly_start_dow"] = v;
    }
    if ("daily_window_offset_hours" in tpObj) {
      const v = tpObj["daily_window_offset_hours"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < -23 || v > 23) {
        throw new BrainConfigError(
          "must be an integer in [-23, 23]",
          "temporal.daily_window_offset_hours",
          source,
        );
      }
      partialTp["daily_window_offset_hours"] = v;
    }
    // Forward-compat: unknown sub-keys under `temporal:` → warning.
    warnUnknownKeys(
      tpObj,
      [
        "stale_pref_days",
        "stale_signal_days",
        "stale_log_days",
        "weekly_start_dow",
        "daily_window_offset_hours",
      ],
      "temporal",
      source,
      warnings,
    );
    temporal = Object.keys(partialTp).length > 0 ? (partialTp as BrainTemporalConfig) : {};
  }

  // Optional `health:` block (v0.14.0). Shape:
  //   health:
  //     contradiction_jaccard: 0.5   # float in (0, 1]
  //     concept_gap_min_frequency: 3 # positive integer
  //     stale_claim_max_age_days: 180
  //     remediation_step_cap: 20
  // Absent block → `cfg.health` undefined; resolveHealth returns the
  // bit-identical defaults.
  let health: BrainHealthConfig | undefined;
  if (hasBlock(obj, "health", knownBlockKeys)) {
    const rawH = obj["health"];
    const hObj = requireMapBlock(rawH, "health", source);
    const partialH: Record<string, unknown> = {};
    if ("contradiction_jaccard" in hObj) {
      const v = hObj["contradiction_jaccard"];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) {
        throw new BrainConfigError(
          "must be a finite number in (0, 1]",
          "health.contradiction_jaccard",
          source,
        );
      }
      partialH["contradiction_jaccard"] = v;
    }
    const positiveIntKeys: ReadonlyArray<
      "concept_gap_min_frequency" | "stale_claim_max_age_days" | "remediation_step_cap"
    > = ["concept_gap_min_frequency", "stale_claim_max_age_days", "remediation_step_cap"];
    for (const key of positiveIntKeys) {
      if (key in hObj) {
        const v = hObj[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
          throw new BrainConfigError("must be a positive integer", `health.${key}`, source);
        }
        partialH[key] = v;
      }
    }
    warnUnknownKeys(
      hObj,
      [
        "contradiction_jaccard",
        "concept_gap_min_frequency",
        "stale_claim_max_age_days",
        "remediation_step_cap",
      ],
      "health",
      source,
      warnings,
    );
    health = Object.keys(partialH).length > 0 ? (partialH as BrainHealthConfig) : {};
  }

  // Optional `notes:` block (v0.11.0). Shape:
  //   notes:
  //     read_paths:
  //       - Daily
  //       - Journal/Weekly
  // Absent block → `cfg.notes` undefined; resolveNotes returns the
  // bit-identical defaults (empty `read_paths`). The list is purely
  // a READ surface; agents never write to these paths.
  let notes: BrainNotesConfig | undefined;
  if (hasBlock(obj, "notes", knownBlockKeys)) {
    const rawNotes = obj["notes"];
    const notesObj = requireMapBlock(rawNotes, "notes", source);
    const partialNotes: Record<string, unknown> = {};
    if ("read_paths" in notesObj) {
      const v = notesObj["read_paths"];
      if (!Array.isArray(v)) {
        throw new BrainConfigError(
          "must be an array of vault-relative folder paths",
          "notes.read_paths",
          source,
        );
      }
      const cleaned: string[] = [];
      v.forEach((entry, idx) => {
        if (typeof entry !== "string") {
          throw new BrainConfigError(
            `must be a string; got ${describe(entry)}`,
            `notes.read_paths[${idx}]`,
            source,
          );
        }
        const trimmed = entry.trim();
        if (trimmed.length === 0) {
          throw new BrainConfigError(
            "must be a non-empty string",
            `notes.read_paths[${idx}]`,
            source,
          );
        }
        if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
          throw new BrainConfigError(
            "must be a vault-relative path (no leading slash)",
            `notes.read_paths[${idx}]`,
            source,
          );
        }
        const segments = trimmed.split(/[\\/]/);
        if (segments.some((s) => s === "..")) {
          throw new BrainConfigError(
            "must not contain '..' segments",
            `notes.read_paths[${idx}]`,
            source,
          );
        }
        cleaned.push(trimmed);
      });
      partialNotes["read_paths"] = cleaned;
    }
    // Forward-compat: unknown sub-keys under `notes:` → warning.
    warnUnknownKeys(notesObj, ["read_paths"], "notes", source, warnings);
    notes = Object.keys(partialNotes).length > 0 ? (partialNotes as BrainNotesConfig) : {};
  }

  // Optional `sessions:` block (Memory Integrity Suite). Shape:
  //   sessions:
  //     ignore_patterns:        ["cron-*"]
  //     stateless_patterns:     ["probe-*"]
  //     ignore_message_patterns: ["^\\[heartbeat\\]"]
  // Session patterns are anchored globs; message patterns are regexes
  // (validated lazily at compile time - an invalid regex degrades to a
  // capture-boundary warning, never a config error, so a typo cannot
  // take the whole Brain config down).
  let sessions: BrainSessionsConfig | undefined;
  if (hasBlock(obj, "sessions", knownBlockKeys)) {
    const rawSessions = obj["sessions"];
    const sessionsObj = requireMapBlock(rawSessions, "sessions", source);
    const partial: Record<string, unknown> = {};
    const LIST_KEYS = ["ignore_patterns", "stateless_patterns", "ignore_message_patterns"];
    for (const key of LIST_KEYS) {
      if (!(key in sessionsObj)) continue;
      const v = sessionsObj[key];
      if (!Array.isArray(v)) {
        throw new BrainConfigError(
          "must be an array of pattern strings",
          `sessions.${key}`,
          source,
        );
      }
      const cleaned: string[] = [];
      v.forEach((entry, idx) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw new BrainConfigError(
            `must be a non-empty string; got ${describe(entry)}`,
            `sessions.${key}[${idx}]`,
            source,
          );
        }
        cleaned.push(entry.trim());
      });
      partial[key] = cleaned;
    }
    warnUnknownKeys(sessionsObj, LIST_KEYS, "sessions", source, warnings);
    sessions = partial as BrainSessionsConfig;
  }

  // Optional `schema:` block (runtime schema-pack foundation). Shape:
  //   schema:
  //     preference_types: [research, decision]
  //     signal_types: [observation]
  //     page_types: [paper]
  //     log_event_kinds: [milestone]
  //     aliases: [decision=choice]
  //     prefixes: [pref=decision]
  //     link_types: [supports]
  //     extractable: [decision]
  //     expert_routing: [decision=schema-author]
  // Absent block leaves cfg.schema undefined; consumers merge built-ins
  // through resolveSchemaVocabulary.
  let schema: BrainSchemaConfig | undefined;
  if (hasBlock(obj, "schema", knownBlockKeys)) {
    const rawSchema = obj["schema"];
    const schemaObj = requireMapBlock(rawSchema, "schema", source);
    const partialSchema: Partial<Record<keyof BrainSchemaConfig, ReadonlyArray<string>>> = {};
    for (const category of SCHEMA_VOCAB_CATEGORIES) {
      if (!(category in schemaObj)) continue;
      const value = schemaObj[category];
      if (!Array.isArray(value)) {
        throw new BrainConfigError(
          "must be an array of schema tokens",
          `schema.${category}`,
          source,
        );
      }
      partialSchema[category] = value;
    }
    const schemaMetaKeys = [
      "aliases",
      "prefixes",
      "link_types",
      "extractable",
      "expert_routing",
    ] as const;
    for (const key of schemaMetaKeys) {
      if (!(key in schemaObj)) continue;
      const value = schemaObj[key];
      if (!Array.isArray(value)) {
        throw new BrainConfigError(
          "must be an array of schema metadata entries",
          `schema.${key}`,
          source,
        );
      }
      partialSchema[key] = value.map((entry, index) => {
        if (typeof entry !== "string") {
          throw new BrainConfigError(
            "must be a string schema metadata entry",
            `schema.${key}[${index}]`,
            source,
          );
        }
        const trimmed = entry.trim();
        if (trimmed.length === 0) {
          throw new BrainConfigError(
            "must be a non-empty schema metadata entry",
            `schema.${key}[${index}]`,
            source,
          );
        }
        return trimmed;
      });
    }
    warnUnknownKeys(
      schemaObj,
      [...(SCHEMA_VOCAB_CATEGORIES as ReadonlyArray<string>), ...schemaMetaKeys],
      "schema",
      source,
      warnings,
    );
    try {
      const declarations = validateSchemaDeclarations(partialSchema);
      schema = {
        ...declarations,
        ...(partialSchema.aliases ? { aliases: partialSchema.aliases } : {}),
        ...(partialSchema.prefixes ? { prefixes: partialSchema.prefixes } : {}),
        ...(partialSchema.link_types ? { link_types: partialSchema.link_types } : {}),
        ...(partialSchema.extractable ? { extractable: partialSchema.extractable } : {}),
        ...(partialSchema.expert_routing ? { expert_routing: partialSchema.expert_routing } : {}),
      } as BrainSchemaConfig;
    } catch (err) {
      if (err instanceof SchemaVocabularyError) {
        const detail = err.message.startsWith(`${err.field}: `)
          ? err.message.slice(err.field.length + 2)
          : err.message;
        throw new BrainConfigError(detail, err.field, source);
      }
      throw err;
    }
  }

  // Optional `hygiene:` block (continuity-hygiene-freshness suite).
  let hygiene: BrainHygieneConfig | undefined;
  if (hasBlock(obj, "hygiene", knownBlockKeys)) {
    const raw = obj["hygiene"];
    const rawMap = requireMapBlock(raw, "hygiene", source);
    const partial: { resolver_cmd?: string; dedup_threshold?: number } = {};
    if ("resolver_cmd" in rawMap) {
      const cmd = rawMap["resolver_cmd"];
      if (typeof cmd !== "string" || cmd.trim() === "") {
        throw new BrainConfigError(
          `must be a non-empty string; got ${describe(cmd)}`,
          "hygiene.resolver_cmd",
          source,
        );
      }
      partial.resolver_cmd = cmd;
    }
    if ("dedup_threshold" in rawMap) {
      const threshold = rawMap["dedup_threshold"];
      if (typeof threshold !== "number" || !(threshold > 0) || threshold > 1) {
        throw new BrainConfigError(
          `must be a number in (0, 1]; got ${describe(threshold)}`,
          "hygiene.dedup_threshold",
          source,
        );
      }
      partial.dedup_threshold = threshold;
    }
    hygiene = Object.freeze(partial);
  }

  // Optional `anticipatory:` block (continuity-hygiene-freshness suite).
  let anticipatory: BrainAnticipatoryConfig | undefined;
  if (hasBlock(obj, "anticipatory", knownBlockKeys)) {
    const raw = obj["anticipatory"];
    const rawMap = requireMapBlock(raw, "anticipatory", source);
    const partial: { ttl_seconds?: number; max_tokens?: number } = {};
    if ("ttl_seconds" in rawMap) {
      requirePositiveInteger("anticipatory.ttl_seconds", rawMap["ttl_seconds"], source);
      partial.ttl_seconds = rawMap["ttl_seconds"] as number;
    }
    if ("max_tokens" in rawMap) {
      requirePositiveInteger("anticipatory.max_tokens", rawMap["max_tokens"], source);
      partial.max_tokens = rawMap["max_tokens"] as number;
    }
    anticipatory = Object.freeze(partial);
  }

  // Optional `recall:` block (continuity-hygiene-freshness suite).
  let recall: BrainRecallConfig | undefined;
  if (hasBlock(obj, "recall", knownBlockKeys)) {
    const raw = obj["recall"];
    const rawMap = requireMapBlock(raw, "recall", source);
    const partial: { degradation?: "hard-cut" | "staged" } = {};
    if ("degradation" in rawMap) {
      const mode = rawMap["degradation"];
      if (mode !== "hard-cut" && mode !== "staged") {
        throw new BrainConfigError(
          `must be 'hard-cut' or 'staged'; got ${describe(mode)}`,
          "recall.degradation",
          source,
        );
      }
      partial.degradation = mode;
    }
    recall = Object.freeze(partial);
  }

  // Optional `feedback:` block (default-scope-feedback suite). Validates a
  // vault-default scope applied to feedback signal writes that omit an
  // explicit per-call scope. Constraints mirror the signal `scope` field
  // exactly (non-empty after trim, single-line, <= SCOPE_MAX_LEN) so a
  // configured default can never pass validation yet fail at write time.
  let feedback: BrainFeedbackConfig | undefined;
  if (hasBlock(obj, "feedback", knownBlockKeys)) {
    const raw = obj["feedback"];
    const rawMap = requireMapBlock(raw, "feedback", source);
    const partial: { default_scope?: string } = {};
    if ("default_scope" in rawMap) {
      const value = rawMap["default_scope"];
      if (typeof value !== "string") {
        throw new BrainConfigError(
          `must be a string; got ${describe(value)}`,
          "feedback.default_scope",
          source,
        );
      }
      const trimmed = value.trim();
      if (trimmed === "") {
        throw new BrainConfigError(
          `must be a non-empty single-line scope slug`,
          "feedback.default_scope",
          source,
        );
      }
      if (/[\n\r]/.test(value)) {
        throw new BrainConfigError(
          `must be single-line (no newline characters)`,
          "feedback.default_scope",
          source,
        );
      }
      if (trimmed.length > SCOPE_MAX_LEN) {
        throw new BrainConfigError(
          `must be at most ${SCOPE_MAX_LEN} characters; got ${trimmed.length}`,
          "feedback.default_scope",
          source,
        );
      }
      partial.default_scope = trimmed;
    }
    // Forward-compat: unknown sub-keys under `feedback:` → warning.
    warnUnknownKeys(rawMap, ["default_scope"], "feedback", source, warnings);
    feedback = Object.freeze(partial);
  }

  // Forward-compat: unknown top-level keys → warning, not error. Runs
  // last (every block above has had a chance to register itself into
  // `knownBlockKeys` via `hasBlock`/`mergeBlock`) so a block can never be
  // parsed-but-not-yet-known at the point this check reads the set. Uses
  // its own message format (distinct from `warnUnknownKeys`'s
  // `block.key: ...` shape), pinned by an existing test.
  for (const key of Object.keys(obj)) {
    if (!knownBlockKeys.has(key)) {
      warnings.push({
        path: source ?? "<config>",
        message: `unknown top-level field '${key}' ignored (forward-compat)`,
      });
    }
  }

  const config: BrainConfig = {
    schema_version: schemaVersion,
    primary_agent: primaryAgent,
    dream: {
      candidate_threshold: dream.candidate_threshold as number,
      unconfirmed_window_days: dream.unconfirmed_window_days as number,
      contradiction_window_days: dream.contradiction_window_days as number,
      // Brain lifecycle suite F6: opt-in heal-phase enrichment. Absent
      // or non-boolean coerces to false so the default install stays
      // byte-identical (the heal phase becomes a checkpoint-only no-op).
      heal_enrich_enabled: dream.heal_enrich_enabled === true,
    },
    retire: {
      stale_evidence_days: retire.stale_evidence_days as number,
    },
    confidence: {
      low_max_applied: confidence.low_max_applied as number,
      medium_min: confidence.medium_min as number,
      high_min: confidence.high_min as number,
    },
    snapshots: {
      retention_count: snapshots.retention_count as number,
    },
    ...(vault !== undefined ? { vault } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(lessons !== undefined ? { lessons } : {}),
    ...(disciplineReport !== undefined ? { discipline_report: disciplineReport } : {}),
    ...(guardrails !== undefined ? { guardrails } : {}),
    ...(linkGraph !== undefined ? { link_graph: linkGraph } : {}),
    ...(temporal !== undefined ? { temporal } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(hygiene !== undefined ? { hygiene } : {}),
    ...(anticipatory !== undefined ? { anticipatory } : {}),
    ...(recall !== undefined ? { recall } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
  };

  return { config, warnings };
}

// ----- Helpers --------------------------------------------------------------

/**
 * Merge a parsed block (or `undefined`) with its default, returning a
 * plain object whose value types are validated downstream. A non-object
 * block (string, number, array) is a hard error — the user probably
 * miswrote the YAML.
 */
/**
 * Narrow a raw config value to a plain object, or throw a field-named
 * `BrainConfigError`. Centralizes the "block must be a map of keys" guard
 * that used to be copy-pasted at every optional-block site with two
 * slightly different wordings ("must be a mapping" vs "must be a map of
 * keys") - callers get one consistent message (`BrainConfigError` already
 * prepends the block's `field` name, so the message itself does not repeat
 * it).
 */
function requireMapBlock(
  raw: unknown,
  blockKey: string,
  source: string | null,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BrainConfigError(`must be a map of keys; got ${describe(raw)}`, blockKey, source);
  }
  return raw as Record<string, unknown>;
}

/**
 * Push one forward-compat warning per key in `map` that isn't in `known`.
 * Replaces the per-block loop that used to mix `Set`, chained `!==`, and
 * (elsewhere) `.includes` for the same "unknown sub-key" check, each with
 * its own copy of the `${blockName}.${key}: unknown field ignored
 * (forward-compat)` message.
 */
function warnUnknownKeys(
  map: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string> | ReadonlyArray<string>,
  blockName: string,
  source: string | null,
  warnings: BrainConfigLoadWarning[],
): void {
  const knownSet = known instanceof Set ? known : new Set(known);
  for (const key of Object.keys(map)) {
    if (!knownSet.has(key)) {
      warnings.push({
        path: source ?? "<config>",
        message: `${blockName}.${key}: unknown field ignored (forward-compat)`,
      });
    }
  }
}

function mergeBlock(
  blockKey: string,
  raw: unknown,
  fallback: Readonly<Record<string, number>>,
  source: string | null,
  knownBlockKeys: Set<string>,
): Record<string, unknown> {
  knownBlockKeys.add(blockKey);
  if (raw === undefined) {
    return { ...fallback };
  }
  const rawMap = requireMapBlock(raw, blockKey, source);
  const merged: Record<string, unknown> = { ...fallback };
  for (const [k, v] of Object.entries(rawMap)) {
    merged[k] = v;
  }
  return merged;
}

/**
 * Record that this call site checked for `key` at the top level, then
 * report whether it's present. Every top-level block/field presence
 * check (`"vault" in obj`, etc.) MUST go through this - or `mergeBlock`,
 * for the four blocks that merge onto numeric defaults instead of being
 * fully optional - so `knownBlockKeys` can never drift from the set of
 * keys this function actually understands (the bug class fixed in
 * phase 0: four blocks were parsed but missing from a hand-maintained
 * `known` list, so valid config produced a false "unknown field"
 * warning). A key that is never checked can never be "known", by
 * construction - there is no separate list to forget to update.
 */
function hasBlock(obj: Record<string, unknown>, key: string, knownBlockKeys: Set<string>): boolean {
  knownBlockKeys.add(key);
  return key in obj;
}

function requirePositiveInteger(field: string, value: unknown, source: string | null): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BrainConfigError(`must be a positive integer; got ${describe(value)}`, field, source);
  }
}

function requireNonNegativeInteger(field: string, value: unknown, source: string | null): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BrainConfigError(
      `must be a non-negative integer; got ${describe(value)}`,
      field,
      source,
    );
  }
}

function requireUnitInterval(field: string, value: unknown, source: string | null): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BrainConfigError(`must be a number in [0, 1]; got ${describe(value)}`, field, source);
  }
}

/**
 * Read an optional integer field bounded to `[min, max]` from a config
 * sub-map. Returns `undefined` when the key is absent; throws a
 * {@link BrainConfigError} (never clamps) when present but out of range
 * or non-integer. Shared by the `lessons:` block loader.
 */
function readBoundedInt(
  map: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  source: string | null,
  field: string = `lessons.${key}`,
): number | undefined {
  if (!(key in map)) return undefined;
  const raw = map[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new BrainConfigError(
      `must be an integer between ${min} and ${max}; got ${describe(raw)}`,
      field,
      source,
    );
  }
  return raw;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  return `${typeof value}(${JSON.stringify(value)})`;
}
