/**
 * Role-separated brain permission gate (v0.10.16).
 *
 * Each MCP brain tool nominates a role (writer, dreamer, applier).
 * Each role is allowed a static subset of operations. The gate is
 * advisory: it does not access the file system, it does not mutate
 * state, it returns a structured decision the caller surfaces as a
 * rejection.
 *
 * Promoting an existing preference to `confirmed` is the one
 * operation that also gates on the source status: the dreamer may
 * only promote a preference that is currently `unconfirmed`.
 * Attempting to "re-promote" an already-confirmed preference is
 * rejected with `wrong-source-state`.
 */

import type {
  BrainPreferenceStatus,
} from "../types.ts";
import {
  BRAIN_OPERATIONS,
  BRAIN_ROLES,
  type BrainOperation,
  type BrainRole,
} from "./role.ts";

export interface RolePermissionResult {
  readonly allowed: boolean;
  /** Structured reason populated when `allowed` is `false`. */
  readonly reason?: string;
}

/**
 * Static role -> set-of-allowed-operations matrix. Used as a quick
 * membership check before any status-dependent refinement.
 */
const ALLOWED: ReadonlyMap<BrainRole, ReadonlySet<BrainOperation>> = new Map([
  [
    BRAIN_ROLES.writer,
    new Set<BrainOperation>([
      BRAIN_OPERATIONS.feedback_write,
      BRAIN_OPERATIONS.preference_create_unconfirmed,
    ]),
  ],
  [
    BRAIN_ROLES.dreamer,
    new Set<BrainOperation>([
      BRAIN_OPERATIONS.preference_promote_confirmed,
      BRAIN_OPERATIONS.preference_retire,
    ]),
  ],
  [
    BRAIN_ROLES.applier,
    new Set<BrainOperation>([
      BRAIN_OPERATIONS.evidence_record,
      BRAIN_OPERATIONS.log_append,
    ]),
  ],
  [BRAIN_ROLES.unknown, new Set<BrainOperation>()],
]);

export function checkRolePermission(
  role: BrainRole,
  op: BrainOperation,
  currentStatus?: BrainPreferenceStatus,
): RolePermissionResult {
  const allowed = ALLOWED.get(role);
  if (allowed === undefined || !allowed.has(op)) {
    return Object.freeze({
      allowed: false,
      reason: `role '${role}' is not permitted to perform '${op}'`,
    });
  }

  // Status-dependent refinement: a dreamer can only promote a
  // preference that is currently `unconfirmed`. Re-promoting an
  // already-confirmed preference (or one that has been retired) is
  // a no-op at best and a permission violation at worst.
  //
  // Fail-closed contract: when `currentStatus` is undefined for the
  // promote operation, the caller could not determine the source
  // state - we reject rather than silently allow. Callers that
  // genuinely know the preference is unconfirmed must say so
  // explicitly.
  if (op === BRAIN_OPERATIONS.preference_promote_confirmed) {
    if (currentStatus === undefined) {
      return Object.freeze({
        allowed: false,
        reason:
          "wrong-source-state: currentStatus is required for preference_promote_confirmed",
      });
    }
    if (currentStatus !== "unconfirmed") {
      return Object.freeze({
        allowed: false,
        reason: `wrong-source-state: cannot promote from '${currentStatus}', expected 'unconfirmed'`,
      });
    }
  }

  return Object.freeze({ allowed: true });
}
