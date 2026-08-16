/**
 * Generator for the `Brain/_brain.yaml` bootstrap template.
 *
 * ## Why a generator
 *
 * The template used to be a hand-written string constant. The validator
 * in `policy.ts` branches on 23 top-level keys; the constant emitted 7.
 * Nothing connected the two, so sixteen keys resolved silently from
 * their defaults and never appeared in the file an operator reads - a
 * gap that grew by one block per release. Deriving the text from the
 * resolver default tables removes the drift mechanism itself; the
 * ratchet in `tests/core/brain/config-template-ratchet.test.ts` fails if
 * a key is added to the resolver without landing here.
 *
 * ## Commented, not live: the judgement call
 *
 * Previously-hidden keys are emitted as COMMENTED defaults rather than
 * live ones. Both options are defensible and the trade is real:
 *
 *   - Live is more discoverable to a reader skimming the file, but it
 *     writes today's default value into every newly-created vault. A
 *     later release that changes a default would then be silently inert
 *     for those vaults, because an explicit value always wins over the
 *     table - the operator never chose the number, the template did. On
 *     a config the bootstrap writes once and never migrates, that is a
 *     one-way door.
 *   - Commented keeps the resolver default authoritative (the key is
 *     absent, so the table still decides) while still showing the reader
 *     the exact key name and its current value. Uncommenting is a
 *     deliberate act that records intent.
 *
 * Commented wins: this repository's stated contract is "byte-identical
 * when absent", and a bootstrap template that pins sixteen defaults into
 * every new vault is the opposite of that. The seven blocks that were
 * already live stay live - grandfathered, because they are the
 * established tuning surface and un-writing them would change what an
 * existing operator's file looks like on the next `brain upgrade`.
 *
 * The ratchet enforces the rule in both directions: nothing new becomes
 * live, and the live surface stays byte-identical to the pre-generation
 * template.
 */

import {
  BRAIN_GUARDRAIL_DEFAULTS,
  BRAIN_HEALTH_DEFAULTS,
  BRAIN_INTEGRITY_DEFAULTS,
  BRAIN_LINK_GRAPH_DEFAULTS,
  BRAIN_NOTES_DEFAULTS,
  BRAIN_SESSIONS_DEFAULTS,
  BRAIN_TEMPORAL_DEFAULTS,
  DEFAULT_BRAIN_CONFIG,
  INJECT_BUDGET_CHARS_DEFAULT,
  INSTALL_HOOK_TIMEOUT_SECONDS_DEFAULT,
  INSTALL_TOOL_PROFILE_DEFAULT,
  INSTALL_TOOL_PROFILE_NAMES,
  LESSONS_CORROBORATION_MIN_DEFAULT,
  LESSONS_HALF_LIFE_DAYS_DEFAULT,
  LESSONS_LIMIT_DEFAULT,
  MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT,
  MOST_APPLIED_LIMIT_DEFAULT,
  MOST_APPLIED_WINDOW_DAYS_DEFAULT,
  STANDING_RULES_MAX_CHARS_DEFAULT,
} from "./policy.ts";
import {
  DEFAULT_ANTICIPATORY_MAX_TOKENS,
  DEFAULT_ANTICIPATORY_TTL_SECONDS,
} from "./anticipatory-cache.ts";
import {
  DEFAULT_FACT_ROLLUP_THRESHOLD,
  DEFAULT_ROLLUP_IDENTITY_THRESHOLD,
} from "./rollup-ladder.ts";
import { SCHEMA_VOCAB_CATEGORIES } from "./schema-vocab.ts";

/**
 * How one key is emitted.
 *
 *   - `live` — written uncommented; the value lands in the file.
 *   - `commented-default` — written commented AT the resolver default,
 *     so uncommenting it is a no-op until the operator edits the value.
 *   - `commented-example` — the resolver default is "absent" (the key
 *     has no default at all), so the value shown is an illustration, not
 *     a default. Excluded from the all-defaults rendering because
 *     writing it would change behaviour.
 */
export type BrainTemplateEmission = "live" | "commented-default" | "commented-example";

export type BrainTemplateValue = number | string | boolean | null | ReadonlyArray<string>;

export interface BrainTemplateKey {
  readonly key: string;
  /** Comment lines rendered above the key, without the leading `#`. */
  readonly doc: ReadonlyArray<string>;
  readonly emit: BrainTemplateEmission;
  readonly value: BrainTemplateValue;
  /**
   * Rendered form, when it differs from the default formatting of
   * `value` (`confidence.medium_min` has always been written `0.40`).
   */
  readonly text?: string;
}

export interface BrainTemplateBlock {
  readonly key: string;
  readonly doc: ReadonlyArray<string>;
  readonly emit: BrainTemplateEmission;
  /** Present for a top-level scalar (`schema_version`, `primary_agent`). */
  readonly scalar?: BrainTemplateValue;
  readonly keys: ReadonlyArray<BrainTemplateKey>;
}

/** A resolver key deliberately left out of the template. */
export interface BrainTemplateOmission {
  /** `block` or `block.sub_key`. */
  readonly key: string;
  readonly reason: string;
}

const G = BRAIN_GUARDRAIL_DEFAULTS;
const T = BRAIN_TEMPORAL_DEFAULTS;
const H = BRAIN_HEALTH_DEFAULTS;
const I = BRAIN_INTEGRITY_DEFAULTS;
const L = BRAIN_LINK_GRAPH_DEFAULTS;

/** Every sub-key of a `commented-default` block that holds an empty list. */
const EMPTY_LIST: ReadonlyArray<string> = Object.freeze([]);

function live(
  key: string,
  value: BrainTemplateValue,
  doc: ReadonlyArray<string> = [],
  text?: string,
): BrainTemplateKey {
  return { key, doc, emit: "live", value, ...(text !== undefined ? { text } : {}) };
}

function def(
  key: string,
  value: BrainTemplateValue,
  doc: ReadonlyArray<string> = [],
): BrainTemplateKey {
  return { key, doc, emit: "commented-default", value };
}

function example(
  key: string,
  value: BrainTemplateValue,
  doc: ReadonlyArray<string>,
): BrainTemplateKey {
  return { key, doc, emit: "commented-example", value };
}

/**
 * The template, block by block, in emission order. Values come from the
 * resolver default tables - never from a literal repeated here - so the
 * file and the resolver cannot disagree about what a default is.
 */
export const BRAIN_CONFIG_TEMPLATE: ReadonlyArray<BrainTemplateBlock> = Object.freeze([
  {
    key: "schema_version",
    doc: [],
    emit: "live",
    scalar: DEFAULT_BRAIN_CONFIG.schema_version,
    keys: [],
  },
  {
    key: "primary_agent",
    doc: [
      "Optional. When set, dream runs from a different agent emit a stderr",
      "warning and a non_primary_agent payload row. The vault should have a",
      "single dream-running runtime even when it is shared across devices",
      "via Syncthing.",
    ],
    emit: "live",
    scalar: DEFAULT_BRAIN_CONFIG.primary_agent,
    keys: [],
  },
  {
    key: "dream",
    doc: [],
    emit: "live",
    keys: [
      live("candidate_threshold", DEFAULT_BRAIN_CONFIG.dream.candidate_threshold),
      live("unconfirmed_window_days", DEFAULT_BRAIN_CONFIG.dream.unconfirmed_window_days),
      live("contradiction_window_days", DEFAULT_BRAIN_CONFIG.dream.contradiction_window_days),
      def("heal_enrich_enabled", DEFAULT_BRAIN_CONFIG.dream.heal_enrich_enabled === true, [
        "Opt-in heal-phase enrichment. Left off, the heal phase is a",
        "checkpoint-only no-op.",
      ]),
    ],
  },
  {
    key: "retire",
    doc: [],
    emit: "live",
    keys: [
      live("stale_evidence_days", DEFAULT_BRAIN_CONFIG.retire.stale_evidence_days),
      example("confirmed_evidence_min_threshold", 3, [
        "Unset by default, which leaves the destructive-from-confirmed gate",
        "off. Set a positive integer to refuse retiring a confirmed, unpinned",
        "preference whose applied+violated count is below it; skipped retires",
        "surface as gated_retires in the dream summary.",
      ]),
    ],
  },
  {
    key: "confidence",
    doc: [],
    emit: "live",
    keys: [
      live("low_max_applied", DEFAULT_BRAIN_CONFIG.confidence.low_max_applied, [
        'low_max_applied gates the "low-evidence-confirmed" doctor warning',
        "and the auto-promotion of unconfirmed preferences to confirmed.",
      ]),
      live(
        "medium_min",
        DEFAULT_BRAIN_CONFIG.confidence.medium_min,
        [
          "Band thresholds on the numeric confidence_value (Wilson lower",
          "bound times freshness decay). value >= high_min ⇒ high;",
          "value >= medium_min ⇒ medium; else low.",
        ],
        DEFAULT_BRAIN_CONFIG.confidence.medium_min.toFixed(2),
      ),
      live("high_min", DEFAULT_BRAIN_CONFIG.confidence.high_min),
    ],
  },
  {
    key: "snapshots",
    doc: [],
    emit: "live",
    keys: [
      live("retention_count", DEFAULT_BRAIN_CONFIG.snapshots.retention_count),
      def("include_derived_store", DEFAULT_BRAIN_CONFIG.snapshots.include_derived_store === true, [
        "Also archive the derived SQLite store next to each snapshot.",
        "Off by default: the store holds embeddings and a tier baseline,",
        "which cost money to rebuild but carry no information the",
        "Markdown tree cannot replay - and every retained archive is",
        "replicated to every peer. The live store size is recorded in",
        "each snapshot manifest whether or not this is on, so the cost",
        "of turning it on is visible before you do.",
      ]),
      def("derived_store_max_bytes", DEFAULT_BRAIN_CONFIG.snapshots.derived_store_max_bytes, [
        "Refuse the snapshot when the live store is larger than this.",
        "A refusal, never a truncation: half a database is not a recovery",
        "point. Worst case on disk is this times retention_count, on every",
        "device the vault replicates to.",
      ]),
    ],
  },
  {
    key: "vault",
    doc: [
      "Vault-wide scope policy. Single source of truth for every",
      "vault walker (search indexer, scan-inline, future scanners).",
      "Entries without a slash match a directory name anywhere in the",
      "tree; entries with a slash match a vault-relative POSIX path",
      "exactly. Remove the block to fall back to the built-in defaults;",
      "set ignore_paths to an empty list to disable exclusions entirely.",
    ],
    emit: "live",
    keys: [
      live("ignore_paths", DEFAULT_BRAIN_CONFIG.vault?.ignore_paths ?? EMPTY_LIST),
      example("include_paths", Object.freeze(["Brain", "Notes/Daily"]), [
        "Positive allowlist. Unset by default, which indexes everything",
        "the exclusions above leave. Set it and a path is walked only if",
        "it is BOTH not excluded and under one of these roots - the two",
        "keys compose, an allowlist never re-includes an exclusion.",
        "The values below are an illustration, not defaults: writing them",
        "would narrow this vault. An empty list is refused - remove the",
        "key to index the whole vault. A bare name matches at any depth",
        "here too, so `Brain` also admits a nested projects/Brain;",
        "name a path when you mean exactly one place.",
      ]),
    ],
  },

  // ----- Below here: every remaining key the resolver understands. ------
  // Commented at its default (see the module docblock for why).

  {
    key: "active",
    doc: [
      "Tuning for the active.md body injected at SessionStart.",
      "standing_rules_max_chars caps the operator-authored",
      "Brain/standing-rules.md block, which is injected first and is",
      "exempt from inject_budget_chars - hence its own number.",
    ],
    emit: "commented-default",
    keys: [
      def("most_applied_window_days", MOST_APPLIED_WINDOW_DAYS_DEFAULT),
      def("most_applied_limit", MOST_APPLIED_LIMIT_DEFAULT),
      def("inject_budget_chars", INJECT_BUDGET_CHARS_DEFAULT),
      def("standing_rules_max_chars", STANDING_RULES_MAX_CHARS_DEFAULT),
    ],
  },
  {
    key: "anticipatory",
    doc: ["Anticipatory context cache: freshness window and size cap."],
    emit: "commented-default",
    keys: [
      def("ttl_seconds", DEFAULT_ANTICIPATORY_TTL_SECONDS),
      def("max_tokens", DEFAULT_ANTICIPATORY_MAX_TOKENS),
    ],
  },
  {
    key: "discipline_report",
    doc: [
      "`o2b discipline report`. No defaults: the block is all-or-nothing,",
      "and an absent block means the report is disabled. The values below",
      "are an illustration, not defaults - every field must be supplied.",
    ],
    emit: "commented-example",
    keys: [
      example("enabled", false, []),
      example("timezone", "UTC", []),
      example("watched_paths", EMPTY_LIST, []),
      example("known_agents", EMPTY_LIST, []),
    ],
  },
  {
    key: "feedback",
    doc: [
      "Vault-default scope stamped on feedback signals that omit one.",
      "Unset by default, which leaves signals scope-less.",
    ],
    emit: "commented-example",
    keys: [example("default_scope", "coding", [])],
  },
  {
    key: "guardrails",
    doc: [
      "Promotion floors and opt-in provenance features. The three",
      "promotion floors default strictly looser than every dream-pass",
      "gate, so they cannot block a promotion that already succeeded.",
    ],
    emit: "commented-default",
    keys: [
      def("promotion_min_signals", G.promotion_min_signals),
      def("promotion_min_distinct_agents", G.promotion_min_distinct_agents),
      def("promotion_min_age_days", G.promotion_min_age_days),
      def("instruction_file_max_lines", G.instruction_file_max_lines),
      def("untrusted_source_delimiting", G.untrusted_source_delimiting),
      def("derived_fact_synthesis", G.derived_fact_synthesis),
      def("provenance_trust_ordering", G.provenance_trust_ordering),
      def("owner_scoped_facts", G.owner_scoped_facts),
      def("marker_writeback", G.marker_writeback),
    ],
  },
  {
    key: "health",
    doc: [
      "Semantic-health detectors, the remediation step cap, and the",
      "wall-clock ceiling past which a materialized artifact is stale.",
    ],
    emit: "commented-default",
    keys: [
      def("contradiction_jaccard", H.contradiction_jaccard),
      def("concept_gap_min_frequency", H.concept_gap_min_frequency),
      def("stale_claim_max_age_days", H.stale_claim_max_age_days),
      def("remediation_step_cap", H.remediation_step_cap),
      def("materialize_max_age_days", H.materialize_max_age_days, [
        "Wall-clock ceiling on a derived artifact's age for the",
        "`--if-stale` fast-path: past this, `o2b brain clusters run`",
        "recomputes even when no input note has moved.",
      ]),
      example("silence_before", "2026-01-01", [
        "Baseline watermark: findings older than this instant are silenced.",
        "Unset by default; `o2b brain health --silence-before` writes it.",
      ]),
    ],
  },
  {
    key: "embeddings",
    doc: [
      "Your own record of a decommission announcement you have read, for",
      "the model you have configured. It layers OVER the survey compiled",
      "into this build, which goes stale between releases; a declaration",
      "here is reported immediately. The two keys are declared together",
      "or not at all - a date with no model would re-target itself the",
      "next time you switched models.",
    ],
    emit: "commented-example",
    keys: [
      example("sunset_model", "text-embedding-3-small", [
        "Exact model string, matched against the configured embedding_model.",
      ]),
      example("sunset_at", "2027-03-01", [
        "Announced decommission date, ISO-8601 (YYYY-MM-DD) or timestamp.",
      ]),
    ],
  },
  {
    key: "hygiene",
    doc: ["Continuity-hygiene pass."],
    emit: "commented-example",
    keys: [
      example("resolver_cmd", "echo", [
        "External resolver invoked for hygiene conflicts. Unset by default,",
        "which leaves conflicts for the operator.",
      ]),
    ],
  },
  {
    key: "integrity",
    doc: [
      "Context-integrity gates. Each gate is off | warn | fail.",
      "pack_validity_seconds bounds how long a built context pack stays",
      "servable; the provenance stamp is the primary invalidator.",
    ],
    emit: "commented-default",
    keys: [
      def("owner_scope_delivery", I.owner_scope_delivery),
      def("embedding_abi", I.embedding_abi),
      def("pack_validity_seconds", I.pack_validity_seconds),
    ],
  },
  {
    key: "lessons",
    doc: ["Signed, recency-scored lessons digest (Brain/lessons.md)."],
    emit: "commented-default",
    keys: [
      def("half_life_days", LESSONS_HALF_LIFE_DAYS_DEFAULT),
      def("corroboration_min", LESSONS_CORROBORATION_MIN_DEFAULT),
      def("limit", LESSONS_LIMIT_DEFAULT),
    ],
  },
  {
    key: "link_graph",
    doc: [
      "MOC-detection thresholds (purely structural - link counts and",
      "character ratios, never vocabulary) and the vault-root instruction",
      "file brain_context surfaces when present.",
    ],
    emit: "commented-default",
    keys: [
      def("moc_min_outbound_links", L.moc_min_outbound_links),
      def("moc_min_link_ratio", L.moc_min_link_ratio),
      def("vault_instruction_file", L.vault_instruction_file),
    ],
  },
  {
    key: "maintenance",
    doc: [
      "Quiet-window maintenance lane (`o2b brain maintenance run`).",
      "The window and the busy threshold are flags on that verb - they",
      "belong to the schedule that invokes it. These two belong to the",
      "vault, because they answer what the cron line cannot: how much of",
      "this machine a background pass may take, and how many times a task",
      "may fail before re-running it stops being a retry.",
    ],
    emit: "commented-default",
    keys: [
      example("host_pressure_percent", 150, [
        "Skip heavy work when the host's one-minute run queue stands at or",
        "above this percentage of the CPUs this process may use (150 = half",
        "again as many runnable tasks as CPUs). Unset by default, which",
        "leaves the gate off - a number here would start refusing work on",
        "vaults whose operator never asked for the gate.",
        "Where the metric is degenerate - a platform whose load average is a",
        "constant, or a cgroup with a CPU bandwidth quota, where the run",
        "queue is the whole host's - the gate stays OPEN and the journal",
        "carries a pressure:unmeasurable line saying which. It never reports",
        "an unreadable host as a quiet one.",
      ]),
      def("failure_streak_limit", MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT, [
        "Refuse a lane task that has failed this many times in a row in the",
        "run journal, instead of retrying it; --force runs it anyway. A",
        "single success clears the streak. Nothing here supervises a",
        "repeating failure, and the lane runs tasks stale-first, so a",
        "permanently broken task would otherwise take the lease first on",
        "every pass.",
      ]),
    ],
  },
  {
    key: "install",
    doc: [
      "Inputs to GENERATED install and hook output (`o2b install`).",
      "They live here rather than in the machine-local config.yaml",
      "because install verification re-CONSTRUCTS the expected file",
      "instead of storing a hash: two machines that clone this vault",
      "must rebuild the same bytes, or each reports the other's correct",
      "install as drift. An environment variable still wins over both.",
    ],
    emit: "commented-default",
    keys: [
      def("hook_timeout_seconds", INSTALL_HOOK_TIMEOUT_SECONDS_DEFAULT, [
        "Seconds a generated lifecycle hook entry may run before the host",
        "kills it. Every hook runs inside a turn the operator is waiting",
        "on, so the ceiling is ten minutes; a larger number is a unit",
        "error rather than an intent.",
      ]),
      def("tool_profile", INSTALL_TOOL_PROFILE_DEFAULT, [
        "Named MCP tool-surface profile the generated registration",
        `selects (${INSTALL_TOOL_PROFILE_NAMES.join(", ")}). Setting it`,
        "here overrides the per-host choice: a runtime that publishes a",
        "tool ceiling (Cursor caps a workspace at 40) gets the bounded",
        "profile its RUNTIME_FACTS row declares, and every other runtime",
        "gets no profile at all, which advertises every tool. An unknown",
        "name is refused here, not failed open: generating a registration",
        "for a profile that does not exist installs a surface nobody named.",
      ]),
    ],
  },
  {
    key: "notes",
    doc: [
      "User-authored folders the agent may READ. Empty means it reads",
      "none; the agent never writes to these paths.",
    ],
    emit: "commented-default",
    keys: [def("read_paths", BRAIN_NOTES_DEFAULTS.read_paths)],
  },
  {
    key: "recall",
    doc: [
      "Per-entry trim strategy when a recall budget is exceeded.",
      "hard-cut keeps the historical mid-sentence cut; staged walks a",
      "sentence -> whole-lines -> hard ladder.",
    ],
    emit: "commented-default",
    keys: [def("degradation", "hard-cut")],
  },
  {
    key: "rollup",
    doc: ["Fact rollup-ladder thresholds."],
    emit: "commented-default",
    keys: [
      def("fact_threshold", DEFAULT_FACT_ROLLUP_THRESHOLD),
      def("identity_threshold", DEFAULT_ROLLUP_IDENTITY_THRESHOLD),
    ],
  },
  {
    key: "schema",
    doc: [
      "Runtime schema-pack declarations. Every list is additive on top of",
      "the built-in vocabulary, so an empty list declares nothing - the",
      "default. Use `o2b schema` to inspect what is already in force",
      "before adding tokens here.",
    ],
    emit: "commented-default",
    keys: [
      ...SCHEMA_VOCAB_CATEGORIES.map((category) => def(category, EMPTY_LIST)),
      def("aliases", EMPTY_LIST),
      def("prefixes", EMPTY_LIST),
      def("link_types", EMPTY_LIST),
      def("extractable", EMPTY_LIST),
      def("expert_routing", EMPTY_LIST),
    ],
  },
  {
    key: "sessions",
    doc: [
      "Session-capture filters. Session patterns are anchored globs;",
      "message patterns are regexes. Empty lists capture everything.",
    ],
    emit: "commented-default",
    keys: [
      def("ignore_patterns", BRAIN_SESSIONS_DEFAULTS.ignore_patterns),
      def("stateless_patterns", BRAIN_SESSIONS_DEFAULTS.stateless_patterns),
      def("ignore_message_patterns", BRAIN_SESSIONS_DEFAULTS.ignore_message_patterns),
    ],
  },
  {
    key: "temporal",
    doc: [
      "Staleness windows and calendar alignment. weekly_start_dow is an",
      "ISO-8601 weekday number (1 = Monday, 7 = Sunday).",
    ],
    emit: "commented-default",
    keys: [
      def("stale_pref_days", T.stale_pref_days),
      def("stale_signal_days", T.stale_signal_days),
      def("stale_log_days", T.stale_log_days),
      def("weekly_start_dow", T.weekly_start_dow),
      def("daily_window_offset_hours", T.daily_window_offset_hours),
    ],
  },
  {
    key: "write_binding",
    doc: [
      "Where a CALLER-NAMED write may land: brain_create_note,",
      "brain_update_note, brain_append_note and brain_write_batch, which",
      "take a vault-relative path from the caller. Unset by default,",
      "which leaves those surfaces unbound exactly as before.",
      "",
      "This is a write boundary over caller-named paths. It is NOT a",
      "security boundary and not per-agent: its authority is this file,",
      "which no tool call can rewrite, and it reads no caller identity.",
      "Writes whose destination is derived rather than named - daily",
      "logs, dream runs, continuity records, telemetry - are outside it.",
      "",
      "The values below are an illustration, not defaults. An empty list",
      "is refused: remove the block to run unbound.",
    ],
    emit: "commented-example",
    keys: [example("path_prefixes", Object.freeze(["Projects", "Journal/Weekly"]), [])],
  },
]) as ReadonlyArray<BrainTemplateBlock>;

/**
 * Resolver keys deliberately absent from the template, each with the
 * reason. The ratchet accepts an omission only when the reason is
 * non-empty - "we forgot" is not expressible here.
 */
export const BRAIN_CONFIG_TEMPLATE_OMISSIONS: ReadonlyArray<BrainTemplateOmission> = Object.freeze([
  {
    key: "hygiene.dedup_threshold",
    reason:
      "Validated by the loader but read by no consumer: no code path reads " +
      "hygiene.dedup_threshold, so templating it would advertise a knob that " +
      "does nothing. Wire a reader (or drop the validation) before documenting it.",
  },
]) as ReadonlyArray<BrainTemplateOmission>;

export interface RenderBrainConfigTemplateOptions {
  /**
   * Render every `commented-default` key as a live one. Used by the
   * ratchet to prove that the commented defaults are exactly the
   * resolver's defaults: the resulting config must resolve identically
   * to an empty one. `commented-example` keys stay out - they have no
   * default, so writing them WOULD change behaviour.
   */
  readonly allDefaultsLive?: boolean;
}

/** Render one scalar in the `_brain.yaml` subset. */
function formatScalar(value: BrainTemplateValue, text?: string): string {
  if (text !== undefined) return text;
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return "[]";
}

/**
 * Line prefixes. A commented BLOCK carries its marker at column 0 (the
 * whole block is inert); a commented KEY inside a live block keeps the
 * block's indentation and carries the marker after it, so it still reads
 * as part of the block it belongs to.
 */
const LIVE_KEY_INDENT = "  ";
const LIVE_LIST_INDENT = "    ";
const BLOCK_COMMENT = "# ";
const KEY_COMMENT = "  # ";
const KEY_COMMENT_LIST = "  #   - ";

function renderKeyLines(entry: BrainTemplateKey, keyIsLive: boolean): string[] {
  const out: string[] = [];
  for (const doc of entry.doc) out.push(`${KEY_COMMENT}${doc}`);
  const list = Array.isArray(entry.value) ? (entry.value as ReadonlyArray<string>) : null;
  const header = keyIsLive ? `${LIVE_KEY_INDENT}${entry.key}` : `${KEY_COMMENT}${entry.key}`;
  if (list !== null && list.length > 0) {
    out.push(`${header}:`);
    for (const item of list) {
      out.push(keyIsLive ? `${LIVE_LIST_INDENT}- ${item}` : `${KEY_COMMENT_LIST}${item}`);
    }
    return out;
  }
  out.push(`${header}: ${formatScalar(entry.value, entry.text)}`);
  return out;
}

/** Comment out an already-rendered live block, line by line. */
function commentOutBlock(lines: ReadonlyArray<string>): string[] {
  return lines.map((line) => (line === "" ? "#" : `${BLOCK_COMMENT}${line}`));
}

/**
 * Render the canonical `Brain/_brain.yaml` body.
 *
 * Deterministic and pure: same inputs, same bytes, every call.
 */
export function renderBrainConfigTemplate(options: RenderBrainConfigTemplateOptions = {}): string {
  const allDefaultsLive = options.allDefaultsLive === true;
  const chunks: string[] = [];
  for (const block of BRAIN_CONFIG_TEMPLATE) {
    const blockIsLive =
      block.emit === "live" || (allDefaultsLive && block.emit !== "commented-example");
    if (allDefaultsLive && !blockIsLive) continue;
    const entries = block.keys.filter(
      (entry) => !(allDefaultsLive && entry.emit === "commented-example"),
    );
    if (block.keys.length > 0 && entries.length === 0) continue;
    const body: string[] = [];
    if (block.scalar !== undefined || block.keys.length === 0) {
      body.push(`${block.key}: ${formatScalar(block.scalar ?? null)}`);
    } else {
      body.push(`${block.key}:`);
      for (const entry of entries) {
        const keyIsLive = entry.emit === "live" || allDefaultsLive;
        body.push(...renderKeyLines(entry, keyIsLive));
      }
    }
    const rendered = blockIsLive ? body : commentOutBlock(body);
    const doc = block.doc.map((line) => `${BLOCK_COMMENT}${line}`);
    chunks.push([...doc, ...rendered].join("\n"));
  }
  return `${chunks.join("\n\n")}\n`;
}

/**
 * Default `_brain.yaml` content written by `o2b brain init`.
 *
 * Generated, not hand-written: see the module docblock. The LIVE keys
 * are byte-identical to the constant this replaced.
 */
export const DEFAULT_BRAIN_CONFIG_YAML = renderBrainConfigTemplate();
