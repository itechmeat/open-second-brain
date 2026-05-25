/**
 * Brain tool role and operation enumeration.
 *
 * Each MCP brain tool runs under one role. Each role is allowed only a
 * static subset of operations on the brain state. The matrix lives in
 * `check-role-permission.ts`; this file is the data-shape atom that
 * both the helper and any caller surface through.
 *
 * Roles:
 *   - `writer`   - tools that accept new taste signals from agents
 *                  (`brain_feedback`).
 *   - `dreamer`  - the deterministic learning pass that promotes or
 *                  retires preferences (`brain_dream`).
 *   - `applier`  - tools that record narrative milestones or evidence
 *                  against existing preferences (`brain_apply_evidence`,
 *                  `brain_note`).
 *   - `unknown`  - default fallback when the caller did not declare a
 *                  role. The permission helper rejects all operations
 *                  in this role.
 *
 * Operations are the smallest unit at which boundaries are enforced:
 *   - `feedback_write`               - write an inbox signal file.
 *   - `preference_create_unconfirmed`- materialise a new unconfirmed
 *                                       preference under
 *                                       `Brain/preferences/`.
 *   - `preference_promote_confirmed` - flip a preference from
 *                                       unconfirmed to confirmed.
 *   - `preference_retire`            - move a preference to
 *                                       `Brain/retired/`.
 *   - `evidence_record`              - append an apply/violate/outdated
 *                                       event to the daily log.
 *   - `log_append`                   - append a narrative note event.
 */

export const BRAIN_ROLES = Object.freeze({
  writer: "writer",
  dreamer: "dreamer",
  applier: "applier",
  unknown: "unknown",
} as const);

export type BrainRole = (typeof BRAIN_ROLES)[keyof typeof BRAIN_ROLES];

const ROLE_SET: ReadonlySet<string> = new Set(Object.values(BRAIN_ROLES));

export function isBrainRole(value: unknown): value is BrainRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

export const BRAIN_OPERATIONS = Object.freeze({
  feedback_write: "feedback_write",
  preference_create_unconfirmed: "preference_create_unconfirmed",
  preference_promote_confirmed: "preference_promote_confirmed",
  preference_retire: "preference_retire",
  evidence_record: "evidence_record",
  log_append: "log_append",
} as const);

export type BrainOperation =
  (typeof BRAIN_OPERATIONS)[keyof typeof BRAIN_OPERATIONS];

const OPERATION_SET: ReadonlySet<string> = new Set(
  Object.values(BRAIN_OPERATIONS),
);

export function isBrainOperation(value: unknown): value is BrainOperation {
  return typeof value === "string" && OPERATION_SET.has(value);
}
