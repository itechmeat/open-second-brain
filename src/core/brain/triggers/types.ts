/**
 * Trigger queue types (Workspace Insight Suite, t_cd1fee79).
 *
 * `InsightCandidate` is the shared record every producer emits - the
 * health/retention/stale adapters, deep vault synthesis, and idea
 * discovery all normalize their findings into this one shape, and the
 * trigger store is its single consumer (Kernel B of the suite).
 */

export const TRIGGER_STATUSES = [
  "pending",
  "delivered",
  "acknowledged",
  "acted",
  "dismissed",
  "expired",
] as const;
export type TriggerStatus = (typeof TRIGGER_STATUSES)[number];

export function isTriggerStatus(value: string): value is TriggerStatus {
  return (TRIGGER_STATUSES as ReadonlyArray<string>).includes(value);
}

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
  readonly path: string;
}
