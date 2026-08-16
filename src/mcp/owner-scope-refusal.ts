/**
 * Why a caller-supplied owner scope is REFUSED instead of honoured.
 *
 * `integrity.owner_scope_delivery: fail` reads as an isolation boundary,
 * and until this module it was the inverse of one. `coerceAgentScope`
 * returned the caller's `agent_scope` argument unconditionally and
 * `resolveOwnerScopeDelivery` enforced exactly that argument, so under
 * the gate a caller read ANY owner's private memories by naming that
 * owner - and the gate's presence implied a check nobody performed. An
 * identity that is echoed back from the request is not an identity.
 *
 * The rule stated here, once: under {@link GATE_MODE.fail} the
 * server-resolved identity is authoritative, and a caller-supplied scope
 * may only AGREE with it. A disagreement is refused by name. Silently
 * substituting the caller's own scope is deliberately not an option -
 * the caller would then believe it had read what it asked for, which is
 * the quiet fallback this repository forbids.
 *
 * Two things this module is careful about:
 *
 *   - The comparison is {@link normalizeAgentScope} on both sides, the
 *     same token normalisation {@link isOwnerVisible} compares with. A
 *     second spelling of "the same owner" would be a second ownership
 *     rule, and the release this module ships in exists because a rule
 *     with two spellings is a rule with none.
 *   - "The server has an identity" is {@link normalizeAgentArgument},
 *     the same predicate every write surface already uses to reject a
 *     guessed name. The bottom of the identity chain is the literal
 *     `"agent"`, which that predicate rejects, so an unconfigured
 *     install cannot silently become an owner.
 *
 * Scope of the refusal: every surface that ACCEPTS the argument, not
 * only the gated preference-delivery ones. The search-backed surfaces
 * are not narrowed by the gate today (see
 * `tests/mcp/agent-scope-matrix.test.ts`), so refusing a foreign scope
 * there closes nothing on its own - but an operator who set the gate has
 * declared owner scope a boundary rather than a filter, and leaving the
 * echo in place on half the surfaces is how it would be re-opened the
 * day those surfaces are gated.
 *
 * Under `warn` and `off` nothing is refused: neither mode withholds
 * anything, so a foreign scope cannot deliver what an absent one would
 * not, and refusing would break `warn`'s whole purpose - watching what
 * `fail` would do before turning it on.
 */

import { normalizeAgentArgument } from "../core/agent-identity.ts";
import { loadIntegrityConfigSafe } from "../core/brain/policy.ts";
import { normalizeAgentScope } from "../core/graph/agent-scope.ts";
import { GATE_MODE } from "../core/integrity/stamp.ts";

/** The operator key that makes the resolved identity authoritative. */
export const OWNER_SCOPE_GATE_KEY = "integrity.owner_scope_delivery";

/** The setting an operator changes to stop being refused. */
const IDENTITY_SETTINGS = "agent_name in the plugin config, or VAULT_AGENT_NAME";

export const OWNER_SCOPE_REFUSAL = Object.freeze({
  /** The request named an owner other than the caller's resolved identity. */
  foreignOwner: "foreign-owner",
  /**
   * The server resolved no usable identity, so no requested owner can be
   * shown to be the caller's own. Fail closed: an unverifiable scope is
   * refused rather than trusted.
   */
  unresolvedIdentity: "unresolved-identity",
} as const);

/** Closed union over {@link OWNER_SCOPE_REFUSAL}. */
export type OwnerScopeRefusal = (typeof OWNER_SCOPE_REFUSAL)[keyof typeof OWNER_SCOPE_REFUSAL];

/** Membership list, in the order the checks are made. */
export const OWNER_SCOPE_REFUSALS: ReadonlyArray<OwnerScopeRefusal> = Object.freeze([
  OWNER_SCOPE_REFUSAL.unresolvedIdentity,
  OWNER_SCOPE_REFUSAL.foreignOwner,
]);

/** Narrow a refusal token read back off a wire or a stored envelope. */
export function isOwnerScopeRefusal(value: unknown): value is OwnerScopeRefusal {
  return (
    typeof value === "string" && (OWNER_SCOPE_REFUSALS as ReadonlyArray<string>).includes(value)
  );
}

/** One caller's request to be answered under a named owner scope. */
export interface OwnerScopeRequest {
  /** The argument the scope arrived in, named in the refusal. */
  readonly argument: string;
  /** The owner the caller asked to be answered as, verbatim. */
  readonly requested: string;
  /** The identity this server resolved for the caller, if it has one. */
  readonly identity: string | undefined;
}

/** A refusal, with the sentence that diagnoses it. */
export interface OwnerScopeRefusalOutcome {
  readonly refusal: OwnerScopeRefusal;
  /** Names both owners, the gate, and what would change the answer. */
  readonly message: string;
}

/**
 * Decide whether `request` may be answered on `vault`, or must be
 * refused. `null` means the request stands: the gate is not `fail`, the
 * requested scope is blank (which narrows nothing), or the caller named
 * its own identity.
 *
 * The gate is read FIRST so a vault that never opted in pays neither the
 * config read's cost nor its verdict.
 */
export function refuseOwnerScopeRequest(
  vault: string,
  request: OwnerScopeRequest,
): OwnerScopeRefusalOutcome | null {
  if (loadIntegrityConfigSafe(vault).owner_scope_delivery !== GATE_MODE.fail) return null;

  const requested = normalizeAgentScope(request.requested);
  if (requested === null) return null;

  const resolved = normalizeAgentScope(normalizeAgentArgument(request.identity) ?? undefined);
  if (resolved === null) {
    return Object.freeze({
      refusal: OWNER_SCOPE_REFUSAL.unresolvedIdentity,
      message:
        `${request.argument} refused (${OWNER_SCOPE_REFUSAL.unresolvedIdentity}): ` +
        `${JSON.stringify(request.requested)} cannot be checked because this ` +
        `server resolved no agent identity, so no requested owner can be shown to be the ` +
        `caller's own. ${OWNER_SCOPE_GATE_KEY}=${GATE_MODE.fail} refuses an owner scope it ` +
        `cannot verify. Set ${IDENTITY_SETTINGS}.`,
    });
  }
  if (resolved === requested) return null;

  return Object.freeze({
    refusal: OWNER_SCOPE_REFUSAL.foreignOwner,
    message:
      `${request.argument} refused (${OWNER_SCOPE_REFUSAL.foreignOwner}): ` +
      `${JSON.stringify(request.requested)} names an owner other than the ` +
      `identity this server resolved for the caller, ${JSON.stringify(resolved)}. ` +
      `${OWNER_SCOPE_GATE_KEY}=${GATE_MODE.fail} makes the resolved identity authoritative, so ` +
      `the request is refused rather than answered as ${JSON.stringify(requested)} or narrowed ` +
      `to ${JSON.stringify(resolved)} behind the caller's back.`,
  });
}
