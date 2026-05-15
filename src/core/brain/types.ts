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

export const BRAIN_PREFERENCE_STATUS = {
  unconfirmed: "unconfirmed",
  confirmed: "confirmed",
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
} as const;
export type BrainRetiredReason =
  (typeof BRAIN_RETIRED_REASON)[keyof typeof BRAIN_RETIRED_REASON];

export const BRAIN_APPLY_RESULT = {
  applied: "applied",
  violated: "violated",
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
} as const;
export type BrainLogEventKind =
  (typeof BRAIN_LOG_EVENT_KIND)[keyof typeof BRAIN_LOG_EVENT_KIND];

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
  readonly confidence: BrainConfidence;
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
  readonly pinned: boolean;
  readonly aliases?: ReadonlyArray<string>;
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
  | BrainSkipCorruptedLogEvent
  | BrainPinLogEvent
  | BrainRollbackLogEvent;

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
}

export interface BrainSnapshotsConfig {
  /** Keep this many newest `.snapshots/*.tar.zst`. Positive integer. */
  readonly retention_count: number;
}

/**
 * Root of `Brain/_brain.yaml`. `schema_version` is mandatory; unknown
 * top-level keys are tolerated as forward-compat (logged as a warning by
 * the validator, not an error).
 */
export interface BrainConfig {
  readonly schema_version: number;
  readonly dream: BrainDreamConfig;
  readonly retire: BrainRetireConfig;
  readonly confidence: BrainConfidenceConfig;
  readonly snapshots: BrainSnapshotsConfig;
}
