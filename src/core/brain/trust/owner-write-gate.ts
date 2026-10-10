/**
 * The owner-write gate (write-side-trust, Task 8): one pure predicate
 * deciding whether a caller-named owner may be written under.
 *
 * `integrity.owner_scope_writes` reads as the write-side sibling of
 * `integrity.owner_scope_delivery`, and it is a sibling rather than a
 * second mode on it because the two gates' `warn` semantics already
 * differ: the delivery gate stamps under `warn`, this one allows and
 * lets the caller log one decision-ledger row. An operator who wants
 * read isolation but not write policing - or the reverse - needs them
 * separable.
 *
 * The rule, stated once: a caller-named owner is a CLAIM, and under
 * {@link GATE_MODE.fail} the resolved identity is authoritative, so the
 * claim may only AGREE with it. A disagreement is refused by name -
 * never silently substituted, because a caller whose owner was swapped
 * behind its back would believe it had written what it asked to write,
 * which is the quiet fallback this repository forbids. The read-side
 * statement of the same rule is `src/mcp/owner-scope-refusal.ts`; the
 * comparison here is the same {@link normalizeAgentScope} token
 * normalisation that side compares with, because a second spelling of
 * "the same owner" would be a second ownership rule.
 *
 * Composition with the permissions document is most-restrictive-wins in
 * BOTH directions, and each direction is pinned by the gate-matrix suite:
 *
 *   - the document can narrow what an `off` gate permits: an
 *     `owner_write` verdict of `deny` refuses the subject's owner writes
 *     whatever the gate says. An `ask` refuses too - this gate has no
 *     review lane to stage an owner write into, and letting the looser
 *     of two verdicts win would be most-restrictive-wins with an
 *     exception, which is to say without the rule.
 *   - the gate can narrow what the document permits: an `allow` verdict
 *     never talks a `fail` gate out of refusing a foreign owner.
 *
 * Under `warn` and `off` this predicate refuses nothing on the gate's
 * own account: `off` is "this vault never opted in" and must be
 * byte-identical, and `warn` exists precisely to let the cross-owner
 * writes through that `fail` would refuse, with the caller logging the
 * row that makes them visible.
 *
 * PURE LEAF like the resolver it consults: no I/O, no clock, no config.
 * Callers resolve the gate mode, the document and the identity, and stay
 * responsible for the warn-side ledger row.
 */

import { normalizeAgentArgument } from "../../agent-identity.ts";
import { normalizeAgentScope } from "../../graph/agent-scope.ts";
import { GATE_MODE, type GateMode } from "../../integrity/stamp.ts";
import type { PermissionsDocument } from "../permissions/document.ts";
import { resolvePermission, type PermissionSubject } from "../permissions/resolve.ts";

/** The operator key that makes the resolved identity authoritative for writes. */
export const OWNER_SCOPE_WRITES_KEY = "integrity.owner_scope_writes";

/** One caller's request to write under a named owner. */
export interface CrossOwnerWriteInput {
  /**
   * The owner token the caller named as an argument (the preference
   * lane's explicit owner). Blank means "no owner named this way".
   */
  readonly explicitOwner?: string;
  /**
   * The owner arriving inside caller-authored frontmatter (the note
   * lane's `owner:` key). Blank means "no owner named this way". When
   * both spellings name an owner, one that disagrees decides.
   */
  readonly frontmatterOwner?: string;
  /** The identity resolved for the caller by the process, not by the request. */
  readonly resolvedIdentity: string;
  /** The resolved `integrity.owner_scope_writes` mode. */
  readonly gateMode: GateMode;
  /** The vault's permissions document, or null when the vault has none. */
  readonly document?: PermissionsDocument | null;
  /** Who is asking, when the document is to be consulted. */
  readonly subject?: PermissionSubject;
}

/**
 * The verdict. The refused arm carries exactly one refusal token - this
 * gate refuses one way only - and a reason naming both owner tokens, the
 * deciding rule, and what would change the answer.
 */
export type CrossOwnerWriteVerdict =
  | { refused: false }
  | { refused: true; token: "owner-write-refused"; reason: string };

const NOT_REFUSED: CrossOwnerWriteVerdict = Object.freeze({
  refused: false,
}) as CrossOwnerWriteVerdict;

/** Normalise one caller-named owner token, or `null` for "none named". */
function namedOwner(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return null;
  return normalizeAgentScope(trimmed);
}

function refused(reason: string): CrossOwnerWriteVerdict {
  return Object.freeze({ refused: true, token: "owner-write-refused", reason });
}

/**
 * Decide whether a write naming `explicitOwner` and/or `frontmatterOwner`
 * may proceed under `gateMode`, or must be refused. Document-first, then
 * the gate: the document's `owner_write` verdict binds whatever the gate
 * mode is, and the gate's own cross-owner check binds whatever the
 * document allowed.
 */
export function refuseCrossOwnerWrite(input: CrossOwnerWriteInput): CrossOwnerWriteVerdict {
  const explicit = namedOwner(input.explicitOwner);
  const fromFrontmatter = namedOwner(input.frontmatterOwner);
  if (explicit === null && fromFrontmatter === null) return NOT_REFUSED;
  const named = explicit ?? fromFrontmatter!;

  // The document verdict needs a subject; without one there is no rule to
  // resolve and the gate alone decides.
  const decision =
    input.document && input.subject
      ? resolvePermission(input.document, input.subject, "owner_write")
      : null;
  if (decision !== null && decision.verdict !== "allow") {
    const askNote =
      decision.verdict === "ask"
        ? "; this gate has no review lane to stage an owner write into, so the ask " +
          "refuses rather than passing"
        : "";
    return refused(
      `write refused (owner-write-refused): the permissions document resolves ` +
        `owner_write for ${JSON.stringify(input.subject!.agent)} to ` +
        `${decision.verdict} via ${decision.source}, so this caller may not name an ` +
        `owner${askNote}. ${OWNER_SCOPE_WRITES_KEY} is ${input.gateMode}; the document ` +
        `and the gate compose most-restrictive-wins, so the document refusal stands.`,
    );
  }

  if (input.gateMode !== GATE_MODE.fail) return NOT_REFUSED;

  // "The caller has an identity" is the predicate every write surface
  // already uses to reject a guessed name, so an unconfigured install
  // cannot become an owner by asking for one.
  const resolved = normalizeAgentScope(normalizeAgentArgument(input.resolvedIdentity) ?? undefined);
  if (resolved === null) {
    return refused(
      `write refused (owner-write-refused): the caller named owner ` +
        `${JSON.stringify(named)}, but the identity resolved for this caller ` +
        `(${JSON.stringify(input.resolvedIdentity)}) does not reduce to one verifiable ` +
        `ownership token - it is blank or a placeholder name - so the owner cannot be ` +
        `shown to be the caller's own. ${OWNER_SCOPE_WRITES_KEY}=${GATE_MODE.fail} refuses ` +
        `an owner it cannot verify rather than trusting it.`,
    );
  }

  const cross =
    (explicit !== null && explicit !== resolved) ||
    (fromFrontmatter !== null && fromFrontmatter !== resolved);
  if (!cross) return NOT_REFUSED;

  return refused(
    `write refused (owner-write-refused): the caller-named owner ` +
      `${JSON.stringify(named)} names an owner other than the identity resolved for ` +
      `this caller, ${JSON.stringify(resolved)}. ${OWNER_SCOPE_WRITES_KEY}=${GATE_MODE.fail} ` +
      `makes the resolved identity authoritative for writes, so the write is refused ` +
      `rather than published under a foreign owner. Name ${JSON.stringify(resolved)}, ` +
      `or write without an explicit owner.`,
  );
}
