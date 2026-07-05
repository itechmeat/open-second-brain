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
export type BrainSignalSign = (typeof BRAIN_SIGNAL_SIGN)[keyof typeof BRAIN_SIGNAL_SIGN];

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
  /** Regex fact extraction (Memory Integrity Suite). */
  extracted: "extracted",
} as const;
export type BrainSignalSourceType =
  (typeof BRAIN_SIGNAL_SOURCE_TYPE)[keyof typeof BRAIN_SIGNAL_SOURCE_TYPE];

const BRAIN_SIGNAL_SOURCE_TYPE_VALUES: ReadonlyArray<BrainSignalSourceType> =
  Object.values(BRAIN_SIGNAL_SOURCE_TYPE);

/** Type-guard for the enum union — used by writer + parser. */
export function isBrainSignalSourceType(v: unknown): v is BrainSignalSourceType {
  return (
    typeof v === "string" && (BRAIN_SIGNAL_SOURCE_TYPE_VALUES as ReadonlyArray<string>).includes(v)
  );
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
export type BrainConfidence = (typeof BRAIN_CONFIDENCE)[keyof typeof BRAIN_CONFIDENCE];

export const BRAIN_MEMORY_LAYER = {
  L0: "L0",
  L1: "L1",
  L2: "L2",
  L3: "L3",
} as const;
export type BrainMemoryLayer = (typeof BRAIN_MEMORY_LAYER)[keyof typeof BRAIN_MEMORY_LAYER];

const BRAIN_MEMORY_LAYER_VALUES: ReadonlyArray<BrainMemoryLayer> =
  Object.values(BRAIN_MEMORY_LAYER);

export function isBrainMemoryLayer(value: unknown): value is BrainMemoryLayer {
  return typeof value === "string" && BRAIN_MEMORY_LAYER_VALUES.includes(value as BrainMemoryLayer);
}

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
export type BrainRetiredReason = (typeof BRAIN_RETIRED_REASON)[keyof typeof BRAIN_RETIRED_REASON];

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
export type BrainApplyResult = (typeof BRAIN_APPLY_RESULT)[keyof typeof BRAIN_APPLY_RESULT];

/**
 * Optional downstream outcome riding on an apply-evidence event
 * (t_d478df53): did the artifact the rule was applied to actually
 * succeed? `unknown` is the explicit "cannot tell" spelling and is
 * treated exactly like an absent outcome - only success/failure
 * persist, so outcome-free vaults stay byte-identical.
 */
export const BRAIN_APPLY_OUTCOME = {
  success: "success",
  failure: "failure",
  unknown: "unknown",
} as const;
export type BrainApplyOutcome = (typeof BRAIN_APPLY_OUTCOME)[keyof typeof BRAIN_APPLY_OUTCOME];

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
  /**
   * `session-lifecycle` — runtime hook observation for session starts,
   * prompt submits, tool uses, stops, and session ends. Payload carries
   * event counters and never blocks the runtime.
   */
  sessionLifecycle: "session-lifecycle",
  /**
   * `reconcile` (Brain lifecycle suite, Feature 3) - the dream reconcile
   * phase recorded a domain-classified contradiction. Payload carries
   * `topic`, `domain`, and either a `reason` (open question) or a
   * `resolution` + `winner_sign` (source-freshness auto-resolution).
   * Emitted only on a changed run, so a no-op stays byte-identical.
   */
  reconcile: "reconcile",
  /**
   * `write-session` (Agent Write Contract Suite, t_bc36a8a2) - one
   * audit row per TERMINAL write-session transition (done, failed,
   * abandoned, approved commit). Payload carries `session_id`, `kind`,
   * `status`, `target`, `attempts`, and whether operator review was
   * required. Non-terminal correction loops stay inside the session
   * file - the log records outcomes, not chatter.
   */
  writeSession: "write-session",
} as const;
export type BrainLogEventKind = (typeof BRAIN_LOG_EVENT_KIND)[keyof typeof BRAIN_LOG_EVENT_KIND];

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

/**
 * Per-preference mutation audit op kinds (Brain lifecycle suite,
 * Feature 1). Captured at the mutation chokepoints. The reader
 * tolerates unknown op strings (forward-compat), so this is the
 * canonical set the writers emit, not a closed validation gate.
 */
export const PREF_AUDIT_OP = {
  create: "create",
  update: "update",
  promote: "promote",
  retire: "retire",
  merge: "merge",
} as const;
export type PrefAuditOp = (typeof PREF_AUDIT_OP)[keyof typeof PREF_AUDIT_OP];

/**
 * One append-only audit line for a single preference mutation. Stored
 * as JSONL under `Brain/log/pref-audit/<pref-id>.jsonl`. `op` is widened
 * to `string` on read so an unknown future op kind round-trips without
 * loss. Revision/hash before-after are `null` where not applicable
 * (e.g. `hash_before` is `null` on a `create`).
 */
export interface PrefAuditRecord {
  readonly ts: string;
  readonly pref_id: string;
  readonly op: PrefAuditOp | string;
  readonly agent: string;
  readonly reason?: string;
  readonly revision_before: number | null;
  readonly revision_after: number | null;
  readonly hash_before: string | null;
  readonly hash_after: string | null;
}

/**
 * Reconcile-phase contradiction domains (Brain lifecycle suite,
 * Feature 3). A contradiction is bucketed by STRUCTURAL signal shape
 * only - never by language. Only `source-freshness` is eligible for
 * deterministic auto-resolution; the judgement domains always surface
 * as operator-facing open questions.
 */
export const RECONCILE_DOMAIN = {
  /** Generic competing assertions; default bucket. Never auto-resolved. */
  claims: "claims",
  /** Signals reference named entities (wikilinks). Never auto-resolved. */
  entity: "entity",
  /** Signals scoped as decisions/judgement calls. Never auto-resolved. */
  decisions: "decisions",
  /** Resolvable by recency: one side is materially fresher. */
  sourceFreshness: "source-freshness",
} as const;
export type ReconcileDomain = (typeof RECONCILE_DOMAIN)[keyof typeof RECONCILE_DOMAIN];

/**
 * An unresolved contradiction the reconcile phase surfaced for operator
 * review instead of force-merging. Carried on {@link DreamRunSummary}
 * and emitted as a `reconcile` log event. The counts are integers so
 * the question is auditable without re-reading signals.
 */
export interface DreamOpenQuestion {
  readonly topic: string;
  readonly scope?: string;
  readonly domain: ReconcileDomain;
  readonly positive_count: number;
  readonly negative_count: number;
  /** Machine-readable reason the contradiction stayed open. */
  readonly reason: string;
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
  /** Optional runtime schema taxonomy token. Inert metadata. */
  readonly schema_type?: string;
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
  /** Optional owner token (v1.7); owner-scoped recall hides it from others. */
  readonly owner?: string;
  /**
   * Provenance trust level (v1.7). Absent reads as `stated`; a derived fact
   * is `deduced` or `inferred` with its premise links in `evidenced_by`.
   */
  readonly provenance?: "stated" | "deduced" | "inferred";
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
   * Categorical band — `low | medium | high`. Derived directly from
   * {@link confidence_value} via the `confidence.medium_min` and
   * `confidence.high_min` thresholds. Stays on the public type so
   * MCP / digest consumers that predate the numeric field keep
   * working unchanged.
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
  /**
   * Brain Integrity Suite: monotonic write counter (v0.12.0). Starts
   * at 0; incremented by `writePreferenceTxn` on every mutation.
   * `StaleUpdate` collision fires when a writer's `expected_revision`
   * does not match this on-disk value. Absent on pre-v0.12.0 files;
   * readers must tolerate `undefined` and coerce to `0`.
   */
  readonly revision?: number;
  /**
   * Brain Integrity Suite: sha256 of the canonical `(principle,
   * scope)` pair (v0.12.0). Written on promotion to `confirmed`;
   * absent for unconfirmed and quarantine preferences. Recomputed on
   * read by {@link verifyContentHash}; a mismatch surfaces as a
   * `drift_detected` event in the log.
   */
  readonly content_hash?: string;
  /**
   * Directional freshness trend (Time-Aware Recall & Activation Suite,
   * t_ee09a6ce): `new | strengthening | stable | weakening | stale`,
   * stamped by the dream refresh from the evidence time distribution.
   * Absent on never-refreshed files; readers treat absent as neutral.
   */
  readonly freshness_trend?: string;
  /** Optional wikilink to a retired pref this one replaces. */
  readonly supersedes?: string;
  readonly aliases?: ReadonlyArray<string>;
  /** Optional runtime schema taxonomy token. Inert metadata. */
  readonly schema_type?: string;
  readonly memory_layer?: BrainMemoryLayer;
  readonly memory_branch?: string;
  readonly related?: ReadonlyArray<string>;
  readonly extends?: ReadonlyArray<string>;
  readonly depends_on?: ReadonlyArray<string>;
  readonly refines?: ReadonlyArray<string>;
  readonly contradicts?: ReadonlyArray<string>;
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
  /** Optional runtime schema taxonomy token. Inert metadata. */
  readonly schema_type?: string;
  readonly memory_layer?: BrainMemoryLayer;
  readonly memory_branch?: string;
  readonly related?: ReadonlyArray<string>;
  readonly extends?: ReadonlyArray<string>;
  readonly depends_on?: ReadonlyArray<string>;
  readonly refines?: ReadonlyArray<string>;
  readonly contradicts?: ReadonlyArray<string>;
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
  /** Downstream outcome when recorded (t_d478df53). */
  readonly outcome?: BrainApplyOutcome;
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

export interface BrainSessionLifecycleLogEvent extends BrainLogEventBase {
  readonly kind: typeof BRAIN_LOG_EVENT_KIND.sessionLifecycle;
  readonly event: string;
  readonly agent: string;
  readonly signals_created: string;
  readonly signals_deduped: string;
  readonly tool_replays: string;
  readonly malformed: string;
  readonly session_id?: string;
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
  | BrainNoteLogEvent
  | BrainSessionLifecycleLogEvent;

// ----- Configuration (`Brain/_brain.yaml`) ----------------------------------

export interface BrainDreamConfig {
  /** Minimum same-sign signal count to promote a topic. */
  readonly candidate_threshold: number;
  /** Days an unconfirmed preference may sit awaiting first application. */
  readonly unconfirmed_window_days: number;
  /** Window in which positive/negative signals cancel each other. */
  readonly contradiction_window_days: number;
  /**
   * Brain lifecycle suite (Feature 6). When `true`, the dream heal
   * phase performs deterministic vault enrichment (fill a missing
   * title from the first H1, link exact title/alias mentions). Default
   * `false` because it rewrites user files - a default install stays
   * byte-identical. Absent is treated as `false`.
   */
  readonly heal_enrich_enabled?: boolean;
}

export interface BrainRetireConfig {
  /** Days without evidence after which a confirmed pref retires. */
  readonly stale_evidence_days: number;
  /**
   * Brain Integrity Suite (v0.12.0). Destructive-from-confirmed gate.
   * When set to a positive integer, the dream pass refuses to retire
   * a confirmed (and unpinned) preference whose accumulated
   * `applied_count + violated_count` is below this threshold. Skipped
   * retires surface in `DreamRunSummary.gated_retires` and stay in
   * `preferences/`. Operator-initiated retires (`user-rejected`,
   * `merged-into`) are never gated. `undefined` (default) preserves
   * pre-v0.12.0 behaviour where any retire that the plan computed
   * lands on disk.
   */
  readonly confirmed_evidence_min_threshold?: number;
}

export interface BrainConfidenceConfig {
  /**
   * Gate for the "low-evidence-confirmed" doctor warning and the
   * auto-promotion of unconfirmed preferences to confirmed.
   * `applied_count <= low_max_applied` keeps a confirmed pref on the
   * doctor watch-list.
   */
  readonly low_max_applied: number;
  /**
   * Lower threshold on the numeric `confidence_value` for the
   * `medium` band. Must be in `[0, 1]` and strictly less than
   * {@link high_min}.
   */
  readonly medium_min: number;
  /**
   * Lower threshold on the numeric `confidence_value` for the
   * `high` band. Must be in `[0, 1]` and strictly greater than
   * {@link medium_min}.
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
  /**
   * Character budget for the active.md body injected at SessionStart
   * (token-diet). Absent means the INJECT_BUDGET_CHARS_DEFAULT from
   * policy.ts applies.
   */
  readonly inject_budget_chars?: number;
}

/**
 * Container for the `lessons:` block of `_brain.yaml` (t_62363378).
 * Tunes the signed, recency-scored lessons digest (`Brain/lessons.md`).
 * Every field is optional; absence falls back to the `LESSONS_*`
 * defaults in policy.ts.
 */
export interface BrainLessonsConfig {
  /** Exponential half-life of the recency decay, in days. */
  readonly half_life_days?: number;
  /** Distinct-result count required to promote a lesson to `preferred`. */
  readonly corroboration_min?: number;
  /** Max lessons rendered into the digest. */
  readonly limit?: number;
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
  /**
   * Opt-in language-agnostic prompt-injection containment (Unit 1).
   * When `true`, untrusted memory bodies surfaced into an agent-facing
   * context pack are wrapped in a provenance-carrying `<untrusted_source>`
   * delimiter and structurally neutralized (invisible/control characters
   * stripped, delimiter breakouts escaped) instead of being matched
   * against the English-only injection blocklist and blanked. Lossless
   * and identical across languages. Defaults to `false`, leaving the
   * legacy blocklist behaviour bit-identical.
   */
  readonly untrusted_source_delimiting?: boolean;
  /**
   * Opt-in derived-fact synthesis (Knowledge Provenance suite, v1.7). When
   * `true`, the `brain_derive_fact` tool is enabled: an agent supplies a
   * second-order conclusion plus its premise preference ids, and it is
   * committed as an unconfirmed preference carrying premise links and a
   * `deduced`/`inferred` provenance level. Synthesis is agent-driven (OSB runs
   * no model); the flag gates the tool, not an automatic dream phase. Defaults
   * to `false`, so the tool refuses and no derived facts are produced.
   */
  readonly derived_fact_synthesis?: boolean;
  /**
   * Opt-in provenance trust ordering (Knowledge Provenance suite, v1.7).
   * When `true`, recall orders an operator-stated rule above a machine-
   * inferred one (stated > deduced > inferred) as a stable tiebreak.
   * Defaults to `false`, leaving recall ordering byte-identical.
   */
  readonly provenance_trust_ordering?: boolean;
  /**
   * Opt-in owner-scoped fact recall (Knowledge Provenance suite, v1.7). When
   * `true`, a fact declaring an `owner:` token is returned only to a matching
   * requested scope; ownerless facts stay shared. Defaults to `false`, so
   * recall is byte-identical when no scope is requested.
   */
  readonly owner_scoped_facts?: boolean;
}

/**
 * Optional `feedback:` block (default-scope-feedback suite). Supplies a
 * vault-default `scope` for feedback signal writes that omit an explicit
 * per-call scope. Distinct from `owner_scoped_facts` and the vault
 * guardrails, which govern fact visibility — this only categorizes
 * freshly-recorded feedback signals.
 */
export interface BrainFeedbackConfig {
  /**
   * Default scope applied to `brain_feedback` / `o2b brain feedback`
   * writes that pass no explicit `scope`. An explicit per-call scope
   * always wins. Validated against the same constraints as a signal
   * `scope` field: non-empty after trim, single-line, and at most the
   * 128-character scope cap. Absent: scope-less calls stay scope-less,
   * byte-identical to prior behaviour.
   */
  readonly default_scope?: string;
}

/**
 * Optional runtime schema vocabulary declarations (v0.25.0 foundation).
 * These are taxonomy tokens, not replacements for operational lifecycle
 * states such as `preference.status` or `apply-evidence` results.
 */
export interface BrainSchemaConfig {
  readonly preference_types?: ReadonlyArray<string>;
  readonly signal_types?: ReadonlyArray<string>;
  readonly page_types?: ReadonlyArray<string>;
  readonly log_event_kinds?: ReadonlyArray<string>;
  readonly aliases?: ReadonlyArray<string>;
  readonly prefixes?: ReadonlyArray<string>;
  readonly link_types?: ReadonlyArray<string>;
  readonly extractable?: ReadonlyArray<string>;
  readonly expert_routing?: ReadonlyArray<string>;
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
  /**
   * Optional `lessons:` block (t_62363378). Tunes the signed,
   * recency-scored lessons digest (`Brain/lessons.md`): decay
   * half-life, corroboration threshold, and rendered limit. Absent:
   * callers fall back to the `LESSONS_*` defaults in policy.ts.
   */
  readonly lessons?: BrainLessonsConfig;
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
  /**
   * Optional `sessions:` block (Memory Integrity Suite). Capture
   * boundaries for session/message ingestion. Absent: every session
   * is captured - bit-identical to pre-boundary behaviour.
   */
  readonly sessions?: BrainSessionsConfig;
  /**
   * Optional `health:` block (v0.14.0). Tunes the semantic-health
   * detectors and the remediation step cap. Absent: callers fall back
   * to `BRAIN_HEALTH_DEFAULTS` via `resolveHealth`.
   */
  readonly health?: BrainHealthConfig;
  /**
   * Optional runtime schema vocabulary declarations. Absent by default;
   * consumers resolve built-ins through `resolveSchemaVocabulary`.
   */
  readonly schema?: BrainSchemaConfig;
  /**
   * Optional `feedback:` block (default-scope-feedback suite). Supplies
   * a default scope for feedback signal writes that omit an explicit
   * per-call scope. Absent: scope-less calls stay scope-less.
   */
  readonly feedback?: BrainFeedbackConfig;
  /**
   * Optional `hygiene:` block (continuity-hygiene-freshness suite).
   * Tunes the hygiene pipeline: the external conflict-resolver command
   * (operator-configured only - never accepted from a tool argument)
   * and the semantic dedup threshold. Absent: no resolver, default
   * threshold.
   */
  readonly hygiene?: BrainHygieneConfig;
  /**
   * Optional `anticipatory:` block (continuity-hygiene-freshness
   * suite). Tunes the anticipatory context cache refreshed by
   * lifecycle hooks. Absent: built-in TTL and budget defaults.
   */
  readonly anticipatory?: BrainAnticipatoryConfig;
  /**
   * Optional `recall:` block (continuity-hygiene-freshness suite).
   * Selects the per-entry budget trim strategy for context-pack and
   * pre-compress. Absent: the historical hard cut.
   */
  readonly recall?: BrainRecallConfig;
}

/** Optional `hygiene:` block (continuity-hygiene-freshness suite). */
export interface BrainHygieneConfig {
  /** External conflict-resolver command (JSON stdin/stdout, fail-open). */
  readonly resolver_cmd?: string;
  /** Cosine threshold for semantic dedup, in (0, 1]. Default 0.97. */
  readonly dedup_threshold?: number;
}

/** Optional `anticipatory:` block (continuity-hygiene-freshness suite). */
export interface BrainAnticipatoryConfig {
  /** Cache freshness/debounce window in seconds. Default 120. */
  readonly ttl_seconds?: number;
  /** Token budget of the cached context pack. Default 2000. */
  readonly max_tokens?: number;
}

/** Optional `recall:` block (continuity-hygiene-freshness suite). */
export interface BrainRecallConfig {
  /** Per-entry trim strategy: historical hard cut or the staged ladder. */
  readonly degradation?: "hard-cut" | "staged";
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
 * Optional `sessions:` block (Memory Integrity Suite). Capture
 * boundaries for runtime session ingestion: ignored sessions produce
 * nothing, stateless sessions read but never write, and suppressed
 * messages never become Brain evidence. Session patterns are anchored
 * globs (`*`, `?`); message patterns are regexes.
 */
export interface BrainSessionsConfig {
  readonly ignore_patterns?: ReadonlyArray<string>;
  readonly stateless_patterns?: ReadonlyArray<string>;
  readonly ignore_message_patterns?: ReadonlyArray<string>;
}

export interface ResolvedBrainSessionsConfig {
  readonly ignore_patterns: ReadonlyArray<string>;
  readonly stateless_patterns: ReadonlyArray<string>;
  readonly ignore_message_patterns: ReadonlyArray<string>;
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
  readonly untrusted_source_delimiting: boolean;
  readonly derived_fact_synthesis: boolean;
  readonly provenance_trust_ordering: boolean;
  readonly owner_scoped_facts: boolean;
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

/**
 * Optional `health:` block (v0.14.0). Tunes the semantic-health
 * detectors (contradiction / concept-gap / stale-claim) and the
 * remediation step cap. Absent: callers fall back to
 * `BRAIN_HEALTH_DEFAULTS` via `resolveHealth`.
 */
export interface BrainHealthConfig {
  /** Minimum principle jaccard for a contradiction pair. Float in (0, 1]. */
  readonly contradiction_jaccard?: number;
  /** Minimum document frequency for a concept gap. Positive integer. */
  readonly concept_gap_min_frequency?: number;
  /** Age (days) past which a confirmed preference's evidence is stale. Positive integer. */
  readonly stale_claim_max_age_days?: number;
  /** Maximum auto-safe steps a single remediation run applies. Positive integer. */
  readonly remediation_step_cap?: number;
}

/**
 * Concrete (fully-resolved) health config. Returned by
 * `resolveHealth(cfg)` so consumers do not branch on optionals.
 */
export interface ResolvedBrainHealthConfig {
  readonly contradiction_jaccard: number;
  readonly concept_gap_min_frequency: number;
  readonly stale_claim_max_age_days: number;
  readonly remediation_step_cap: number;
}
