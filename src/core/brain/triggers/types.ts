/**
 * Trigger queue types (Workspace Insight Suite, t_cd1fee79).
 *
 * `InsightCandidate` is the shared record every producer emits - the
 * health/retention/stale adapters, deep vault synthesis, and idea
 * discovery all normalize their findings into this one shape, and the
 * trigger store is its single consumer (Kernel B of the suite).
 */

/**
 * Lifecycle states of one trigger.
 *
 * `suppressed` is the operator's judgement that a finding is
 * structurally benign: unlike `dismissed` and `acted` it carries no
 * clock, so the cooldown key stays silent until somebody unsuppresses
 * it. It is a member of {@link TRIGGER_TERMINAL_STATUSES}, and that
 * membership - not a branch anywhere - is what hides it from `list` and
 * shows it in `history`.
 *
 * `snoozed` is the time-boxed sibling: a deferral that ends by itself
 * when its window elapses or the finding's grounding moves, whichever
 * comes first. It is terminal too, so the same partition membership
 * hides it from `list` - but its window, not the TTL expiry clock, is
 * what wakes it.
 */
export const TRIGGER_STATUS = Object.freeze({
  pending: "pending",
  delivered: "delivered",
  acknowledged: "acknowledged",
  acted: "acted",
  dismissed: "dismissed",
  expired: "expired",
  suppressed: "suppressed",
  snoozed: "snoozed",
} as const);

export type TriggerStatus = (typeof TRIGGER_STATUS)[keyof typeof TRIGGER_STATUS];

/**
 * The statuses in lifecycle order. The single source every schema, enum
 * and filter reads from - a literal copy of this list in a tool schema
 * is exactly the drift the vocabulary census exists to catch.
 */
export const TRIGGER_STATUSES: ReadonlyArray<TriggerStatus> = Object.freeze([
  TRIGGER_STATUS.pending,
  TRIGGER_STATUS.delivered,
  TRIGGER_STATUS.acknowledged,
  TRIGGER_STATUS.acted,
  TRIGGER_STATUS.dismissed,
  TRIGGER_STATUS.expired,
  TRIGGER_STATUS.suppressed,
  TRIGGER_STATUS.snoozed,
]);

export function isTriggerStatus(value: unknown): value is TriggerStatus {
  return typeof value === "string" && (TRIGGER_STATUSES as ReadonlyArray<string>).includes(value);
}

/**
 * Statuses a trigger can still move out of on its own. Expiry is applied
 * to these and only these, which is what makes `suppressed` indefinite
 * without any code saying so.
 */
export const TRIGGER_OPEN_STATUSES: ReadonlySet<TriggerStatus> = new Set([
  TRIGGER_STATUS.pending,
  TRIGGER_STATUS.delivered,
  TRIGGER_STATUS.acknowledged,
]);

/**
 * Statuses that end the trigger's own lifecycle. Every reader that hides
 * finished work from `list` and shows it in `history` partitions on this
 * set; the three hand-maintained copies it replaced (core, CLI, MCP)
 * could each drift from the others without a single test noticing.
 */
export const TRIGGER_TERMINAL_STATUSES: ReadonlySet<TriggerStatus> = new Set([
  TRIGGER_STATUS.acted,
  TRIGGER_STATUS.dismissed,
  TRIGGER_STATUS.expired,
  TRIGGER_STATUS.suppressed,
  TRIGGER_STATUS.snoozed,
]);

export const TRIGGER_URGENCIES = ["low", "medium", "high"] as const;
export type TriggerUrgency = (typeof TRIGGER_URGENCIES)[number];

export function isTriggerUrgency(value: string): value is TriggerUrgency {
  return (TRIGGER_URGENCIES as ReadonlyArray<string>).includes(value);
}

export const TRIGGER_KINDS = [
  "contradiction",
  "stale_claim",
  "concept_gap",
  "batch_inflation",
  "retention_action",
  "knowledge_gap",
  "open_question",
  "orphan_research",
  "idea_direction",
  "agent_collision",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export function isTriggerKind(value: string): value is TriggerKind {
  return (TRIGGER_KINDS as ReadonlyArray<string>).includes(value);
}

/** One grounded proactive finding, ready to become a trigger. */
export interface InsightCandidate {
  readonly kind: TriggerKind;
  readonly urgency: TriggerUrgency;
  /** Why this needs attention - deterministic evidence, never prose guesses. */
  readonly reason: string;
  /** What the operator can do about it. */
  readonly suggestedAction: string;
  /** Wikilinks / paths of the artifacts the finding is grounded in. */
  readonly sourceArtifacts: ReadonlyArray<string>;
  /** Enough context to act without a separate search step. */
  readonly contextSnippets: ReadonlyArray<string>;
  /**
   * Stable dedup key: the same issue must map to the same key on every
   * scan so it cannot reappear while an earlier trigger is live or
   * cooling down. Convention: `<kind>:<primary-artifact[:secondary]>`.
   */
  readonly cooldownKey: string;
}

/** A persisted trigger - one Markdown file under `Brain/triggers/`. */
export interface TriggerRecord extends InsightCandidate {
  readonly id: string;
  /** Status as written in the file. */
  readonly status: TriggerStatus;
  /** Status with expiry applied at read time. */
  readonly effectiveStatus: TriggerStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly deliveredAt: string | null;
  /** Timestamp of the terminal transition (acknowledge counts as open). */
  readonly resolvedAt: string | null;
  /** When the trigger was suppressed, or `null` while it is not. */
  readonly suppressedAt: string | null;
  /**
   * The status suppression interrupted, restored verbatim by
   * `unsuppress`. `null` while the trigger is not suppressed. A
   * suppressed record that lacks it has been hand-edited, and the
   * restore refuses rather than guessing a prior state.
   */
  readonly suppressedFrom: TriggerStatus | null;
  /**
   * The grounding fingerprint the dismissal covers: a content hash of
   * the finding's reason and context, taken when it was dismissed. A
   * dismissed finding is resurrected only by movement - a re-fire that
   * introduces an artifact the record never saw, or one whose grounding
   * content hashes differently from this baseline - so for the kinds
   * whose cooldown key pins their artifact ids (and whose artifact set
   * can therefore never change) a re-evidenced finding still comes back.
   * `null` on a record dismissed before the field existed: absence is
   * the neutral reading, and the artifact arm of the gate still works
   * without it.
   */
  readonly dismissedFingerprint: string | null;
  /** When the trigger was snoozed, or `null` while it is not. */
  readonly snoozedAt: string | null;
  /**
   * The grounding fingerprint the snooze baseline covers: a content hash
   * of the finding's reason and context, taken when it was snoozed. The
   * early wake fires on movement since that baseline - a re-fire that
   * introduces an artifact the record never saw, or one whose grounding
   * content hashes differently - never on a bare re-sighting, because
   * the detectors report state and a still-true condition re-fires on
   * every scan. `null` while the trigger is not snoozed, or on a record
   * snoozed before the field existed: absence is the neutral reading,
   * and the artifact arm of the wake still works without it.
   */
  readonly snoozedFingerprint: string | null;
  /**
   * When the snooze window ends. The store always writes it alongside
   * `snoozedAt`, so `null` means a hand-edited record - and one without
   * a window never wakes by the clock, only by grounding movement.
   */
  readonly snoozedUntil: string | null;
  /**
   * The status the snooze interrupted, restored once the window ends or
   * the finding's grounding moves, whichever comes first. Seeded from
   * the record's computed status at snooze time, so it is open by
   * construction and never `snoozed` - a snooze cannot restore into
   * snoozed. `null` while the trigger is not snoozed.
   */
  readonly snoozedFrom: TriggerStatus | null;
  /**
   * How many times this finding has been observed: once when the trigger
   * was created, plus once for every later SCAN in which the finding
   * fired and this record is why nothing surfaced. One scan seeing the
   * same finding twice counts once, so this is a count of scans rather
   * than of candidates. A record written before the ledger existed
   * carries no count and reads as `1`, which is the true number of
   * occurrences anyone recorded for it - not a default standing in for
   * an unknown.
   */
  readonly occurrences: number;
  /**
   * When the finding last fired, whether or not anything was surfaced.
   * A record written before the ledger existed reads as its creation
   * instant, which is the last occurrence anyone recorded.
   */
  readonly lastSeenAt: string;
  readonly path: string;
}
