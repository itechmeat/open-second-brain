/**
 * Type definitions for the Brain observing-memory layer.
 *
 * These are plain data shapes — no behaviour, no I/O. They describe the
 * frontmatter contracts of every Brain artifact (signal, preference,
 * retired, log entry) plus the schema of `_brain.yaml`. Parsers and
 * writers (added in Task 2) produce and consume these shapes; the dream
 * algorithm (Task 3) operates on collections of them.
 *
 * Anchored in `docs/plans/2026-05-15-brain-observing-memory.md`,
 * sections 5 (file formats) and 10 (configuration).
 */

// ----- Status & retire-reason enums -----------------------------------------
//
// We use `as const` objects with derived union types instead of TypeScript
// `enum` declarations. `enum` does not interoperate well with
// `verbatimModuleSyntax: true` (which this repo enables) and the
// `as const` form survives type-only re-exports cleanly.

export const BRAIN_SIGNAL_SIGN = {
  positive: "positive",
  negative: "negative",
} as const;
export type BrainSignalSign =
  (typeof BRAIN_SIGNAL_SIGN)[keyof typeof BRAIN_SIGNAL_SIGN];

/**
 * Where the signal came from (§9 / §16 capture extensions). Absent
 * on signals written by older OSB versions; the reader treats absence
 * as `live` but never injects a default into the parsed object.
 *
 *   - `live`    — written by live `brain_feedback` (CLI or MCP).
 *   - `inline`  — captured by `o2b brain scan-inline` from an
 *                 `@osb` marker in a vault file.
 *   - `session` — replayed from a session JSONL by
 *                 `o2b brain import-session`.
 */
export const BRAIN_SIGNAL_SOURCE_TYPE = {
  live: "live",
  inline: "inline",
  session: "session",
} as const;
export type BrainSignalSourceType =
  (typeof BRAIN_SIGNAL_SOURCE_TYPE)[keyof typeof BRAIN_SIGNAL_SOURCE_TYPE];

const BRAIN_SIGNAL_SOURCE_TYPE_VALUES: ReadonlyArray<BrainSignalSourceType> =
  Object.values(BRAIN_SIGNAL_SOURCE_TYPE);

/** Type-guard for the enum union — used by writer + parser. */
export function isBrainSignalSourceType(v: unknown): v is BrainSignalSourceType {
  return typeof v === "string"
    && (BRAIN_SIGNAL_SOURCE_TYPE_VALUES as ReadonlyArray<string>).includes(v);
}

export const BRAIN_PREFERENCE_STATUS = {
  unconfirmed: "unconfirmed",
  confirmed: "confirmed",
  // Probation state for a previously-confirmed preference whose recent
  // evidence is dominantly negative (violated_count ≥ applied_count AND
  // applied_count > low_max_applied). The rule is still active and is
  // listed in `Brain/active.md`, but the digest surfaces it in a
  // separate section. A single additional `violated` evidence event
  // retires the preference with `retired_reason: quarantine-violated`;
  // an `applied` event that restores `applied_count > violated_count`
  // sends it back to `confirmed`.
  quarantine: "quarantine",
} as const;
export type BrainPreferenceStatus =
  (typeof BRAIN_PREFERENCE_STATUS)[keyof typeof BRAIN_PREFERENCE_STATUS];

export const BRAIN_CONFIDENCE = {
  low: "low",
  medium: "medium",
  high: "high",
} as const;
export type BrainConfidence =
  (typeof BRAIN_CONFIDENCE)[keyof typeof BRAIN_CONFIDENCE];

export const BRAIN_RETIRED_REASON = {
  staleNoEvidence: "stale-no-evidence",
  expiredUnconfirmed: "expired-unconfirmed",
  rebutted: "rebutted",
  userRejected: "user-rejected",
  // Quarantined preference (see BRAIN_PREFERENCE_STATUS.quarantine) that
  // received at least one further `violated` evidence event. Distinct
  // from `rebutted`, which fires when opposite-sign *signals* (not
  // evidence) accumulate above the candidate threshold.
  quarantineViolated: "quarantine-violated",
  // Preference retired because an apply-evidence event marked it
  // `outdated` — the rule's scope still matches but the artifact
  // shows that the rule itself is obsolete (framework migration,
  // convention change). Single `outdated` event is enough; the
  // evidence is interpreted as a definitive contextual rebuttal.
  supersededByContext: "superseded-by-context",
  // Preference retired through `o2b brain merge` — counters and
  // evidence were folded into the retained pref pointed at by
  // `superseded_by`. Distinct from `rebutted` (opposing signals)
  // and `superseded-by-context` (outdated evidence): merge implies
  // no contradiction, the two rules said the same thing.
  mergedInto: "merged-into",
} as const;
export type BrainRetiredReason =
  (typeof BRAIN_RETIRED_REASON)[keyof typeof BRAIN_RETIRED_REASON];

export const BRAIN_APPLY_RESULT = {
  applied: "applied",
  violated: "violated",
  // The rule matched the artifact's scope but is no longer current —
  // a framework migration, convention change, or upstream rewrite
  // makes the preference obsolete in this specific application.
  // Dream interprets any `outdated` evidence as a retire trigger
  // (reason `superseded-by-context`); pinned prefs emit a
  // `retain-pinned` log entry instead.
  outdated: "outdated",
} as const;
export type BrainApplyResult =
  (typeof BRAIN_APPLY_RESULT)[keyof typeof BRAIN_APPLY_RESULT];

/**
 * All possible log event types. `dream` summarises a run; `feedback`
 * records the creation of a signal; `apply-evidence` records a real-work
 * application; `force-confirmed` records a `--force-confirmed` flag use;
 * `reject` / `promote` / `retire` record the corresponding state
 * transitions; `noted-redundant` records same-sign signals collapsed onto
 * an active pref; `skip-corrupted-frontmatter` records files dream
 * skipped; `pin` / `unpin` record protected-set changes; `rollback`
 * records a snapshot restore. See §5.5 and §7.4 of the design doc.
 */
export const BRAIN_LOG_EVENT_KIND = {
  dream: "dream",
  feedback: "feedback",
  applyEvidence: "apply-evidence",
  forceConfirmed: "force-confirmed",
  reject: "reject",
  promote: "promote",
  retire: "retire",
  notedRedundant: "noted-redundant",
  skipCorruptedFrontmatter: "skip-corrupted-frontmatter",
  pin: "pin",
  unpin: "unpin",
  rollback: "rollback",
  /**
   * `signal-suppressed` — a fresh signal landed on a topic that the
   * user explicitly retired via `o2b brain reject <pref> --reason`.
   * Dream emits one event per suppressed signal and does NOT count it
   * toward a new candidate preference. The audit row carries the
   * original retired-pref wikilink + the user's reason so the
   * suppression decision is recoverable.
   */
  signalSuppressed: "signal-suppressed",
  /**
   * `scan-inline` (§9) — operator ran `o2b brain scan-inline`.
   * Payload: counters (`scanned`, `created`, `deduped`, `malformed`).
   */
  scanInline: "scan-inline",
  /**
   * `import-session` (§16) — operator ran
   * `o2b brain import-session <path>`. One log block per session
   * file; payload references the file and adapter id.
   */
  importSession: "import-session",
  /**
   * `merge` (§12) — operator ran `o2b brain merge <keep> <drop>`.
   * Payload carries both wikilinks plus union-size of `evidenced_by`
   * and the summed counters as raw integers for audit grepping.
   */
  merge: "merge",
  /**
   * `upgrade` (§22) — operator ran `o2b brain upgrade --apply`. Payload
   * carries the pre-apply snapshot run id, agent identity, and the
   * vault-relative paths of every managed file that was rewritten.
   */
  upgrade: "upgrade",
  /**
   * `import-claude-memory` — operator imported Claude Code memory via
   * `o2b brain import-claude-memory <path>`. One log block per import;
   * payload carries counters for created, updated, recreated, and skipped
   * entries, plus conflict and snapshot information.
   */
  importClaudeMemory: "import-claude-memory",
  /**
   * `note` (§32B, v0.10.8) — one narrative-milestone line written by
   * the `brain_note` MCP tool. Payload carries `text` (one-line
   * description) and `agent`. Not consumed by the dream pass beyond
   * counting; it exists so an agent has a Brain-native home for
   * "release X shipped" / "PR Y merged" / "discovered fact Z" lines
   * instead of falling back to the deprecated `event_log_append`
   * surface.
   */
  note: "note",
} as const;
export type BrainLogEventKind =
  (typeof BRAIN_LOG_EVENT_KIND)[keyof typeof BRAIN_LOG_EVENT_KIND];

/**
 * Precomputed set of every event-kind string. Both the markdown
 * parser (`appendLogEvent`) and the JSONL reader (`readLogDay`) need
 * the same set to validate incoming kinds; canonicalising the
 * construction here keeps the two readers in lockstep.
 */
export const BRAIN_LOG_EVENT_KIND_SET: ReadonlySet<string> = new Set(
  Object.values(BRAIN_LOG_EVENT_KIND),
);

/**
 * Type guard narrowing an arbitrary string to {@link BrainLogEventKind}.
 * Use at boundary checks (CLI flag parsing, MCP input coercion, JSONL
 * deserialisation) so the typed-string union flows through downstream
 * code without a runtime `as` cast.
 */
export function isBrainLogEventKind(value: string): value is BrainLogEventKind {
  return BRAIN_LOG_EVENT_KIND_SET.has(value);
}

// ----- File-frontmatter shapes ----------------------------------------------

/**
 * Raw taste signal (`Brain/inbox/sig-*.md`).
 *
 * Immutable after creation. Required fields are enforced at write time;
 * optional fields default per the design doc §5.2.
 */
export interface BrainSignal {
  readonly kind: "brain-signal";
  /** Filename basename without `.md`. Equals `sig-<date>-<slug>`. */
  readonly id: string;
  /** ISO-8601 UTC timestamp. */
  readonly created_at: string;
  /**
   * Includes `brain`, `brain/signal`, and per-topic / per-scope tags. The
   * parser preserves whatever the writer emitted; the writer guarantees
   * the canonical set.
   */
  readonly tags: ReadonlyArray<string>;
  /** Required dedup anchor for `dream`. */
  readonly topic: string;
  /** Optional soft category (e.g. `writing`, `coding`). */
  readonly scope?: string;
  /** Sign of the signal. */
  readonly signal: BrainSignalSign;
  /** Source agent or human name. */
  readonly agent: string;
  /** Optional wikilinks to context artifacts. */
  readonly source?: ReadonlyArray<string>;
  /**
   * One-line agent-readable formulation of the rule this signal points
   * toward. Carried into the resulting preference's `principle` when a
   * cluster of signals is promoted.
   */
  readonly principle: string;
  /** Optional free-form raw body following the frontmatter. */
  readonly raw?: string;
  /**
   * Origin of the signal (§9 / §16). Absent on signals written by
   * older OSB versions — downstream code must treat undefined as
   * semantically equivalent to `live`, never inject a default.
   */
  readonly source_type?: BrainSignalSourceType;
  /**
   * Normalised payload hash anchored to (topic, signal, principle,
   * scope). Idempotency anchor for `scan-inline` (§9) and
   * `import-session` (§16). Absent on signals written by older OSB
   * versions.
   */
  readonly dedup_hash?: string;
  /**
   * Source coordinates for session-imported signals (§16):
   * `<path>#<turn-id>`. Empty / absent for inline / live signals.
   */
  readonly session_ref?: string;
  /** Bi-temporal event-time start (additive optional, v0.10.18). */
  readonly valid_from?: string;
  /** Bi-temporal event-time end (additive optional, v0.10.18). */
  readonly valid_until?: string;
  /** Bi-temporal transaction-time (additive optional, v0.10.18). */
  readonly recorded_at?: string;
}

/**
 * Rule promoted from a cluster of signals (`Brain/preferences/pref-*.md`).
 *
 * Two states: `unconfirmed` (just promoted) and `confirmed` (applied at
 * least once in real work). Counter fields are computed by `dream` from
 * the log and rewritten on every run — never hand-edited.
 */
export interface BrainPreference {
  readonly kind: "brain-preference";
  /** Filename basename without `.md`. Equals `pref-<slug>`. */
  readonly id: string;
  /** ISO-8601 UTC timestamp of promotion. */
  readonly created_at: string;
  /** ISO-8601 UTC of first `applied` evidence; `null` while unconfirmed. */
  readonly confirmed_at: string | null;
  /** ISO-8601 UTC trial deadline (`created_at + unconfirmed_window_days`). */
  readonly unconfirmed_until: string;
  readonly tags: ReadonlyArray<string>;
  readonly topic: string;
  readonly scope?: string;
  readonly status: BrainPreferenceStatus;
  readonly principle: string;
  /** Origin signals; fixed at creation. Wikilinks (`[[sig-...]]`). */
  readonly evidenced_by: ReadonlyArray<string>;
  /** Computed from `Brain/log/`. */
  readonly applied_count: number;
  /** Computed from `Brain/log/`. */
  readonly violated_count: number;
  /** ISO-8601 UTC of most recent `apply-evidence` entry. */
  readonly last_evidence_at: string | null;
  /**
   * Categorical band — `low | medium | high`. Derived from
   * {@link confidence_value} after the count-based hard floors
   * (`applied <= low_max_applied`, `violated >= applied`, etc.) are
   * applied. Stays on the public type so MCP / digest consumers that
   * predate the numeric field keep working unchanged.
   */
  readonly confidence: BrainConfidence;
  /**
   * Continuous Wilson-95% lower bound on `applied / (applied +
   * violated)`, modulated by freshness decay over
   * `retire.stale_evidence_days`. `null` on legacy files written by
   * pre-v0.10.3 dream passes; downstream code that needs a numeric
   * value must tolerate the `null` and fall back to the band.
   */
  readonly confidence_value: number | null;
  /**
   * If `true`, exempt from automatic retire reasons (`stale-no-evidence`,
   * `expired-unconfirmed`, `rebutted`). Defaults to `false` when a parsed
   * note lacks the field — parsers MUST coerce missing/`null`/`undefined`
   * to `false`.
   */
  readonly pinned: boolean;
  /** Optional wikilink to a retired pref this one replaces. */
  readonly supersedes?: string;
  readonly aliases?: ReadonlyArray<string>;
  /**
   * Bi-temporal: event-time start. ISO-8601 UTC timestamp marking
   * when the rule was first considered true (independent of when the
   * vault learned about it). Additive optional - absent on legacy
   * files; readers must tolerate `undefined`.
   */
  readonly valid_from?: string;
  /**
   * Bi-temporal: event-time end. ISO-8601 UTC timestamp marking when
   * the rule stopped being considered true. Additive optional.
   */
  readonly valid_until?: string;
  /**
   * Bi-temporal: transaction-time. ISO-8601 UTC timestamp marking
   * when the vault recorded the rule (distinct from `created_at`,
   * which is the dream-pass promotion moment). Additive optional.
   */
  readonly recorded_at?: string;
}

/**
 * Retired preference (`Brain/retired/ret-*.md`).
 *
 * Same identity slug as the originating preference; the prefix flips
 * from `pref-` to `ret-`. The frontmatter inherits the preference's
 * fields (topic, principle, evidenced_by, …) plus the retirement
 * metadata below.
 */
export interface BrainRetired {
  readonly kind: "brain-retired";
  /** Filename basename without `.md`. Equals `ret-<slug>`. */
  readonly id: string;
  readonly status: "retired";
  /** ISO-8601 UTC timestamp of the retire transition. */
  readonly retired_at: string;
  readonly retired_reason: BrainRetiredReason;
  /** Wikilink to the `dream` run (or CLI action) that retired it. */
  readonly retired_by: string;
  /** Optional wikilink to a newer preference that supersedes this one. */
  readonly superseded_by?: string;
  // ----- Inherited from the preference (snapshot at retire time) -----
  readonly created_at: string;
  readonly tags: ReadonlyArray<string>;
  readonly topic: string;
  readonly scope?: string;
  readonly principle: string;
  readonly evidenced_by: ReadonlyArray<string>;
  readonly applied_count: number;
  readonly violated_count: number;
  readonly last_evidence_at: string | null;
  readonly confidence: BrainConfidence;
  /**
   * Snapshot of the numeric `confidence_value` at retire time.
   * `null` on retired files produced by pre-v0.10.3 dream passes;
   * downstream code must tolerate the `null`.
   */
  readonly confidence_value: number | null;
  readonly pinned: boolean;
  readonly aliases?: ReadonlyArray<string>;
  /**
   * When the retire transition was driven by `o2b brain reject`, the
   * operator-supplied free-form reason is mirrored here so future dream
   * passes can render it in `## Why retired` and so signal-suppression
   * can quote the original objection. `null` for non-`user-rejected`
   * retires.
   */
  readonly user_rejected_reason?: string | null;
  /** Bi-temporal event-time start (additive optional, v0.10.18). */
  readonly valid_from?: string;
  /** Bi-temporal event-time end (additive optional, v0.10.18). */
  readonly valid_until?: string;
  /** Bi-temporal transaction-time (additive optional, v0.10.18). */
  readonly recorded_at?: string;
}

/**
 * One row of evidence (applied / violated / outdated) extracted from
 * `Brain/log/<date>.md` for a specific preference. Pure derived view —
 * `dream` reconstructs the recent slice on every run from the canonical
 * log, never persisted as its own file.
 */
export interface BrainEvidenceSummary {
  readonly timestamp: string;
  readonly artifact: string;
  readonly result: BrainApplyResult;
  readonly agent?: string;
  readonly note?: string;
}

// ----- Log events -----------------------------------------------------------

/**
 * Common shape of every parsed log event. The `payload` map carries the
 * heading-specific key/value bullets verbatim (everything that follows
 * the `## <time> — <kind>` heading). Concrete event narrators consume
 * `payload` and translate it into typed views as needed.
 */
export interface BrainLogEventBase {
  readonly kind: BrainLogEventKind;
  /** ISO-8601 UTC timestamp reconstructed from `<YYYY-MM-DD>` + `HH:MM:SS`. */
  readonly at: string;
  /** Bullet payload of the event entry, key → string|string[] (lists). */
  readonly payload: Readonly<Record<string, string | ReadonlyArray<string>>>;
}

/** `dream` run summary entry. */
export interface BrainDreamLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.dream;
  readonly run_id: string;
}

/** `apply-evidence` entry — one application against a preference. */
export interface BrainApplyEvidenceLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.applyEvidence;
  /** Wikilink target of the preference, e.g. `pref-no-internal-abbrev`. */
  readonly preference: string;
  /** Wikilink of the artifact where the rule was applied. */
  readonly artifact: string;
  readonly agent: string;
  readonly result: BrainApplyResult;
  readonly note?: string;
}

/** `feedback` entry — new signal created. */
export interface BrainFeedbackLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.feedback;
  readonly signal: string;
  readonly topic: string;
  readonly sign: BrainSignalSign;
}

/** `force-confirmed` entry — `--force-confirmed` bypass. */
export interface BrainForceConfirmedLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.forceConfirmed;
  readonly preference: string;
  readonly agent: string;
}

/** `reject` entry — explicit user rejection. */
export interface BrainRejectLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.reject;
  readonly preference: string;
  readonly reason?: string;
}

/** `promote` entry — unconfirmed → confirmed transition. */
export interface BrainPromoteLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.promote;
  readonly preference: string;
}

/** `retire` entry — preference moved to `retired/`. */
export interface BrainRetireLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.retire;
  readonly preference: string;
  readonly reason: BrainRetiredReason;
}

/** `noted-redundant` entry — same-sign signal on an active pref. */
export interface BrainNotedRedundantLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.notedRedundant;
  readonly preference: string;
  readonly signal: string;
}

/**
 * `signal-suppressed` entry — fresh signal landed on a topic that
 * the user previously rejected via `o2b brain reject --reason`. The
 * dream pass dropped it from the candidate-pref planner and moved
 * the file to `processed/`. Persisted with a wikilink to the
 * retired pref + the original user-supplied reason so the audit
 * trail is complete.
 */
export interface BrainSignalSuppressedLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.signalSuppressed;
  readonly signal: string;
  readonly retired: string;
  readonly topic: string;
  readonly reason: string;
}

/** `skip-corrupted-frontmatter` — a file dream couldn't parse. */
export interface BrainSkipCorruptedLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.skipCorruptedFrontmatter;
  /** Vault-relative path of the offending file. */
  readonly path: string;
}

/** `pin` / `unpin` entry — protected-set change. */
export interface BrainPinLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.pin | typeof BRAIN_LOG_EVENT_KIND.unpin;
  readonly preference: string;
}

/** `rollback` entry — snapshot restored. */
export interface BrainRollbackLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.rollback;
  readonly run_id: string;
}

/**
 * `scan-inline` entry — operator ran `o2b brain scan-inline`. Payload
 * keys are counters: `scanned`, `found`, `created`, `deduped`,
 * `malformed`, `errors`, plus the agent identity.
 */
export interface BrainScanInlineLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.scanInline;
}

/**
 * `import-session` entry — one block per session file imported by
 * `o2b brain import-session`. Payload carries the file wikilink,
 * adapter id, and counters.
 */
export interface BrainImportSessionLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.importSession;
}

/**
 * `merge` entry — operator ran `o2b brain merge <keep> <drop>`.
 * Payload carries the titled wikilinks to both prefs plus the
 * union-size of `evidenced_by` and the summed counters as raw
 * integers for audit grepping.
 */
export interface BrainMergeLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.merge;
  readonly keep: string;
  readonly drop: string;
  readonly agent: string;
}

/**
 * `upgrade` entry — operator ran `o2b brain upgrade --apply`.
 * Payload carries the upgrade run id (`upgrade-<ts>`), agent
 * identity, the pre-apply snapshot path, and the vault-relative
 * paths of every managed file the run rewrote.
 */
export interface BrainUpgradeLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.upgrade;
  readonly run_id: string;
}

/**
 * `import-claude-memory` entry — operator ran
 * `o2b brain import-claude-memory <path>`. Payload carries
 * counters for created, updated, recreated, skipped_unchanged,
 * skipped_non_feedback, plus conflict and snapshot information.
 */
export interface BrainImportClaudeMemoryLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.importClaudeMemory;
}

/**
 * `note` entry — one narrative-milestone line. Not consumed by the
 * dream pass; it exists so an agent has a Brain-native home for
 * "I shipped X" / "PR Y merged" lines.
 */
export interface BrainNoteLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.note;
  readonly text: string;
  readonly agent: string;
}

/** Discriminated union of every concrete log event type. */
export type BrainLogEvent =
  | BrainDreamLogEvent
  | BrainApplyEvidenceLogEvent
  | BrainFeedbackLogEvent
  | BrainForceConfirmedLogEvent
  | BrainRejectLogEvent
  | BrainPromoteLogEvent
  | BrainRetireLogEvent
  | BrainNotedRedundantLogEvent
  | BrainSignalSuppressedLogEvent
  | BrainSkipCorruptedLogEvent
  | BrainPinLogEvent
  | BrainRollbackLogEvent
  | BrainScanInlineLogEvent
  | BrainImportSessionLogEvent
  | BrainMergeLogEvent
  | BrainUpgradeLogEvent
  | BrainImportClaudeMemoryLogEvent
  | BrainNoteLogEvent;

// ----- Configuration (`Brain/_brain.yaml`) ----------------------------------

export interface BrainDreamConfig {
  /** Minimum same-sign signal count to promote a topic. */
  readonly candidate_threshold: number;
  /** Days an unconfirmed preference may sit awaiting first application. */
  readonly unconfirmed_window_days: number;
  /** Window in which positive/negative signals cancel each other. */
  readonly contradiction_window_days: number;
}

export interface BrainRetireConfig {
  /** Days without evidence after which a confirmed pref retires. */
  readonly stale_evidence_days: number;
}

export interface BrainConfidenceConfig {
  /** `applied_count <= low_max_applied` → confidence `low`. */
  readonly low_max_applied: number;
  /** `applied_count >= high_min_applied` is required for `high`. */
  readonly high_min_applied: number;
  /**
   * Fresh-evidence factor: `now - last_evidence_at <
   * stale_evidence_days * high_freshness_factor`. Must be in `(0, 1]`.
   */
  readonly high_freshness_factor: number;
  /**
   * Lower threshold on the numeric `confidence_value` for the
   * derived `medium` band. Anything below this lands as `low` after
   * the legacy count-based hard floors. Must be in `[0, 1]` and
   * strictly less than {@link high_min}.
   */
  readonly medium_min: number;
  /**
   * Lower threshold on the numeric `confidence_value` for the
   * derived `high` band. Must be in `[0, 1]` and strictly greater
   * than {@link medium_min}.
   */
  readonly high_min: number;
}

export interface BrainSnapshotsConfig {
  /** Keep this many newest `.snapshots/*.tar.zst`. Positive integer. */
  readonly retention_count: number;
}

/**
 * Vault-wide exclusion policy (`Brain/_brain.yaml` → `vault:`).
 *
 * Single source of truth for every vault walker — search indexer,
 * `scan-inline`, future scanners. Anchored in
 * `docs/plans/2026-05-19-vault-scope-design.md` §4.
 *
 * Entries without `/` are bare directory names matched at any
 * depth; entries containing `/` are vault-relative POSIX paths
 * matched exactly. The block is optional in `_brain.yaml`; absence
 * (or absence of `ignore_paths`) leaves this field `undefined` and
 * the walkers fall back to `DEFAULT_VAULT_IGNORE_PATHS`. An
 * explicit empty array is a user choice meaning "exclude nothing".
 */
export interface BrainVaultConfig {
  readonly ignore_paths: ReadonlyArray<string>;
}

/**
 * Configuration for the `Most-applied (Nd)` block surfaced both in
 * `Brain/active.md` and the `brain_digest` output (v0.10.11).
 *
 * Both fields are optional in `_brain.yaml`; absence means consumers
 * fall back to `MOST_APPLIED_WINDOW_DAYS_DEFAULT` (30) and
 * `MOST_APPLIED_LIMIT_DEFAULT` (10).
 */
export interface BrainMostAppliedConfig {
  readonly window_days: number;
  readonly limit: number;
}

/** Container for the `active:` block of `_brain.yaml`. */
export interface BrainActiveConfig {
  readonly most_applied?: BrainMostAppliedConfig;
}

/**
 * Optional configuration for the daily discipline report (§D of the
 * agent-discipline-tail design). Absent on vaults that have not opted
 * in; the loader returns `undefined` rather than injecting defaults.
 */
export interface DisciplineReportConfig {
  readonly enabled: boolean;
  readonly timezone: string;
  readonly watched_paths: ReadonlyArray<string>;
  readonly known_agents: ReadonlyArray<string>;
}

/**
 * Optional `guardrails:` block (v0.10.16). Tunes the dream pass
 * self-approval thresholds (`promotion_*`) and the doctor
 * instruction-file-ceiling warning (`instruction_file_max_lines`).
 *
 * Any subset of the four fields may be present; missing fields fall
 * back to `BRAIN_GUARDRAIL_DEFAULTS` via `resolveGuardrails`. Absent
 * block leaves the field undefined and keeps current behaviour
 * bit-identical.
 */
export interface BrainGuardrailConfig {
  /**
   * Minimum same-sign signal count required for the dream pass to
   * auto-promote a topic from unconfirmed to confirmed. Below this,
   * the topic is quarantined and waits for more evidence.
   */
  readonly promotion_min_signals?: number;
  /**
   * Minimum number of distinct agents that must have raised
   * same-sign signals for the topic. Defaults to `1` (i.e. no
   * cross-agent requirement).
   */
  readonly promotion_min_distinct_agents?: number;
  /**
   * Minimum age (in days) of the earliest signal in the cluster
   * before promotion is permitted. `0` means "no age gate".
   */
  readonly promotion_min_age_days?: number;
  /**
   * Hard ceiling (in lines) on vault-root instruction files
   * (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`). Files above this size
   * surface a doctor warning.
   */
  readonly instruction_file_max_lines?: number;
}

/**
 * Root of `Brain/_brain.yaml`. `schema_version` is mandatory; unknown
 * top-level keys are tolerated as forward-compat (logged as a warning by
 * the validator, not an error).
 *
 * `primary_agent` declares which runtime owns the `dream` consolidation
 * pass for this vault. Multi-device setups (e.g. Syncthing-shared
 * vaults) benefit from a single dream-running host so signal
 * processing stays serialised. `null` (the default) means "no primary
 * declared" — every dream invocation runs without an identity check.
 * When set, dream runs from a different `agent_name` emit a stderr
 * warning and a `non_primary_agent` log-payload row but still
 * complete: enforcement is observability, not access control.
 */
export interface BrainConfig {
  readonly schema_version: number;
  readonly primary_agent: string | null;
  readonly dream: BrainDreamConfig;
  readonly retire: BrainRetireConfig;
  readonly confidence: BrainConfidenceConfig;
  readonly snapshots: BrainSnapshotsConfig;
  /**
   * Vault-wide exclusion policy (v0.10.9). Absent when the user
   * has not declared `vault.ignore_paths` in `_brain.yaml`; the
   * resolver falls back to `DEFAULT_VAULT_IGNORE_PATHS` in that
   * case. Present with an empty `ignore_paths` array means "the
   * user explicitly wants no exclusions".
   */
  readonly vault?: BrainVaultConfig;
  /**
   * Optional `active.most_applied` block (v0.10.11). Drives both the
   * `Most-applied (Nd)` section in `Brain/active.md` and the
   * mirrored `most_applied` block in `brain_digest`.
   */
  readonly active?: BrainActiveConfig;
  /** Optional daily discipline-report configuration (§D). Absent when not configured. */
  readonly discipline_report?: DisciplineReportConfig;
  /**
   * Optional `guardrails:` block (v0.10.16). Tunes the dream pass
   * self-approval thresholds and the instruction-file-ceiling
   * warning. Absent: callers fall back to `BRAIN_GUARDRAIL_DEFAULTS`
   * via `resolveGuardrails`, keeping current behaviour bit-identical.
   */
  readonly guardrails?: BrainGuardrailConfig;
  /**
   * Optional `link_graph:` block (v0.10.17). Tunes the MOC audit
   * thresholds and names the vault-root instruction file the
   * `brain_context` envelope surfaces. Absent: callers fall back to
   * `BRAIN_LINK_GRAPH_DEFAULTS` via `resolveLinkGraph`.
   */
  readonly link_graph?: BrainLinkGraphConfig;
  /**
   * Optional `temporal:` block (v0.10.18). Drives the temporal +
   * synthesis subsystem (`src/core/brain/temporal/`) - stale-watch
   * thresholds, weekly window alignment, daily window offset.
   * Absent: callers fall back to `BRAIN_TEMPORAL_DEFAULTS` via
   * `resolveTemporal`.
   */
  readonly temporal?: BrainTemporalConfig;
  /**
   * Optional `notes:` block (v0.11.0). Declares vault-relative
   * folders the agent may READ user-authored notes from (daily
   * journal, weekly notes, ...). Absent or empty list means the
   * agent does not read any user-authored notes. Agents never write
   * to these paths - the type is `read_paths` for a reason.
   */
  readonly notes?: BrainNotesConfig;
}

/**
 * Optional `notes:` block (v0.11.0). User-authored notes the agent
 * may read from. The list is purely a READ surface: `scan-inline`
 * and session-import scan these roots for `@osb` markers. The agent
 * never writes here; user-named folders (`Daily/`, `Journal/`, ...)
 * stay user-owned.
 */
export interface BrainNotesConfig {
  /**
   * Vault-relative folders the agent may read from. Empty or absent
   * list means "no user-authored notes to scan".
   */
  readonly read_paths?: ReadonlyArray<string>;
}

export interface ResolvedBrainNotesConfig {
  readonly read_paths: ReadonlyArray<string>;
}

/**
 * Concrete (fully-resolved) guardrail config. Returned by
 * `resolveGuardrails(cfg)` so consumers do not have to handle
 * optionals - the resolver fills missing fields with
 * `BRAIN_GUARDRAIL_DEFAULTS`.
 */
export interface ResolvedBrainGuardrailConfig {
  readonly promotion_min_signals: number;
  readonly promotion_min_distinct_agents: number;
  readonly promotion_min_age_days: number;
  readonly instruction_file_max_lines: number;
}

/**
 * Optional `link_graph:` block (v0.10.17). Drives the MOC audit
 * threshold heuristics. Absent: callers fall back to
 * `BRAIN_LINK_GRAPH_DEFAULTS` via `resolveLinkGraph`.
 *
 * Both knobs are purely structural - link counts and ratios over
 * body length. No vocabulary detection of "this looks like a MOC".
 */
export interface BrainLinkGraphConfig {
  /**
   * Minimum number of outbound wikilinks a note must have for
   * `auditMoc` to treat it as a MOC candidate. Below this the audit
   * throws so callers don't misinterpret a thin note as a hub.
   */
  readonly moc_min_outbound_links?: number;
  /**
   * Minimum ratio of wikilink characters to non-whitespace body
   * characters. A high-density link-list note crosses this; a prose
   * note with a few inline references does not.
   */
  readonly moc_min_link_ratio?: number;
  /**
   * Vault-relative path of the user-authored instruction file the
   * `brain_context` envelope optionally surfaces. Defaults to
   * `VAULT.md`. The file is read on demand, NOT injected by a
   * scheduler.
   */
  readonly vault_instruction_file?: string;
}

export interface ResolvedBrainLinkGraphConfig {
  readonly moc_min_outbound_links: number;
  readonly moc_min_link_ratio: number;
  readonly vault_instruction_file: string;
}

/**
 * Optional `temporal:` block (v0.10.18). Tunes the temporal +
 * synthesis subsystem (`src/core/brain/temporal/`).
 *
 * All knobs are purely structural - thresholds in days and ISO-8601
 * weekday numbers. No language-specific defaults; no vocabulary
 * detection.
 */
export interface BrainTemporalConfig {
  /**
   * Days since a preference's most-recent event before it is reported
   * by `findStaleEntries`. Positive integer.
   */
  readonly stale_pref_days?: number;
  /**
   * Days since a signal's most-recent event before it is reported as
   * stale. Positive integer.
   */
  readonly stale_signal_days?: number;
  /**
   * Days since a Brain/log/ file was last touched before it is
   * reported as stale. Positive integer.
   */
  readonly stale_log_days?: number;
  /**
   * Weekly-synthesis window alignment. ISO-8601 weekday number
   * (1 = Monday ... 7 = Sunday). Default 1.
   */
  readonly weekly_start_dow?: number;
  /**
   * Daily-brief window offset from UTC in whole hours, range -23..23.
   * 0 means days align with UTC midnight. Non-zero values let
   * non-UTC vaults align daily briefs with local midnight without
   * adding a full timezone library.
   */
  readonly daily_window_offset_hours?: number;
}

/**
 * Concrete (fully-resolved) temporal config. Returned by
 * `resolveTemporal(cfg)` so consumers do not branch on optionals.
 */
export interface ResolvedBrainTemporalConfig {
  readonly stale_pref_days: number;
  readonly stale_signal_days: number;
  readonly stale_log_days: number;
  readonly weekly_start_dow: number;
  readonly daily_window_offset_hours: number;
}
