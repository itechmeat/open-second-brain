/**
 * The egress consent stamp: a record of WHAT WOULD LEAVE the machine,
 * made before anything leaves.
 *
 * ## What a stamp is
 *
 * A stamp answers one question - "if this were to go, what would go?" -
 * and it answers it about the payload as it would ACTUALLY be sent: the
 * payload has been through the shared egress guard, so the stamp carries
 * the redacted payload rather than the caller's intent. A stamp that
 * carried the intent would be a record of a wish, and a wish is not what
 * crosses a boundary.
 *
 * ## The two refusals
 *
 *   1. THE KILL SWITCH. When the operator has set the kill-switch
 *      variable, every stamp is refused - whatever any other environment
 *      value says, and whatever the grant says. The switch is a
 *      PRESENCE switch: a non-empty value of any kind keeps the refusal
 *      in force, because the point of a kill switch is that no
 *      environment value can talk it out of it. The next variable in the
 *      environment does not get to say otherwise.
 *   2. NO CONSENT. A stamp is a consent record, so a process that has
 *      not been granted egress consent gets no stamp. The default is a
 *      refusal, not a stamp: a consent feature whose default is "yes" is
 *      not a consent feature.
 *
 * The order matters and is not a detail: the kill switch is read FIRST,
 * so a machine that has both the grant and the kill switch refuses, and
 * the test matrix in `tests/core/egress-consent-stamp.test.ts` drives
 * every granting value against the kill switch to keep it that way.
 *
 * ## What a refusal discloses
 *
 * The payload class. "Egress refused" tells an operator nothing they can
 * act on; "vault page bodies were withheld" names the thing that was
 * withheld, which is the thing they can go and look at. The class is
 * supplied by the caller, because only the caller knows what it is
 * offering to the boundary, and a refusal that named a wrong class would
 * be worse than one that named none.
 *
 * ## No destination is declared here
 *
 * This release declares no egress destination, so this module declares
 * no row in the egress registry and the site is an INPUT: the caller
 * names the destination it is stamping for, and the registry row for
 * that destination lands with the destination itself. The primitive is
 * the consent half of that seam; the other half is a place to send
 * bytes, and there is not one yet.
 */

import { parseBool } from "../validate.ts";
import { EGRESS_OUTCOME, redactForEgress, type EgressPolicy } from "./guard.ts";
import type { EgressSiteId } from "./registry.ts";

/**
 * How a stamp came back. Not the guard's outcome vocabulary and not the
 * trust rail's: this one answers "may this leave", which is a different
 * question from "did the scan clear it" and from "did a person consent
 * to a guarded write".
 */
export const CONSENT_STAMP_OUTCOME = Object.freeze({
  /** The stamp is issued: consent is recorded and the payload is cleared. */
  stamped: "stamped",
  /** No stamp: nothing may leave. */
  withheld: "withheld",
} as const);

export type ConsentStampOutcome =
  (typeof CONSENT_STAMP_OUTCOME)[keyof typeof CONSENT_STAMP_OUTCOME];

/**
 * The environment variable that GRANTS egress consent. Its granting
 * values are the repository's truthy spellings, so an operator who has
 * written `OPEN_SECOND_BRAIN_EGRESS_CONSENT=true` in their shell profile
 * means what they mean everywhere else in this tree.
 */
export const CONSENT_STAMP_ENV = "OPEN_SECOND_BRAIN_EGRESS_CONSENT";

/**
 * The environment variable that REFUSES every stamp. Presence is what
 * counts: a non-empty value of any kind - including one that reads as
 * "off" to a boolean parser - keeps the refusal in force, because no
 * environment value may re-enable egress once the operator has killed
 * it.
 */
export const CONSENT_STAMP_KILL_ENV = "OPEN_SECOND_BRAIN_EGRESS_CONSENT_KILL";

/** The values of {@link CONSENT_STAMP_ENV} that grant consent. */
export const CONSENT_STAMP_GRANT_VALUES: ReadonlyArray<string> = Object.freeze(["1", "true"]);

/** A stamp that was issued. */
export interface ConsentStampStamped<T> {
  readonly outcome: typeof CONSENT_STAMP_OUTCOME.stamped;
  /** What would leave, named for the operator. */
  readonly payloadClass: string;
  /** The redacted payload: what would ACTUALLY leave. */
  readonly payload: T;
  /** True when the guard changed the payload, so the copy differs. */
  readonly redacted: boolean;
  /** The operator-facing sentence. Never empty. */
  readonly detail: string;
}

/** A stamp that was refused. */
export interface ConsentStampWithheld {
  readonly outcome: typeof CONSENT_STAMP_OUTCOME.withheld;
  /** What would have left, named for the operator. */
  readonly payloadClass: string;
  /** The operator-facing refusal. Never empty; it discloses the class. */
  readonly detail: string;
  /** Why the stamp was refused. Never empty; it discloses the class. */
  readonly reason: string;
  /**
   * The tree locations the guard reported as secret-shaped identifiers,
   * empty unless the guard was the one that refused.
   */
  readonly secretIdentifiers: ReadonlyArray<string>;
}

/** Issued or refused. A union, so a refusal cannot be read as a stamp. */
export type ConsentStampVerdict<T> = ConsentStampStamped<T> | ConsentStampWithheld;

/** What the caller offers to the boundary. */
export interface ConsentStampRequest<T> {
  /**
   * The destination the stamp is for. This release declares no egress
   * destination, so the primitive has none of its own: the caller names
   * the site it is stamping for.
   */
  readonly site: EgressSiteId;
  /**
   * WHAT WOULD LEAVE, in the caller's words. Named in every refusal,
   * because a refusal that does not say what was withheld is a sentence
   * the operator cannot act on.
   */
  readonly payloadClass: string;
  /** The payload offered to the boundary. */
  readonly payload: T;
  /** The environment the consent is read from. */
  readonly env?: NodeJS.ProcessEnv;
  /** The guard's per-site policy, when the call site has one. */
  readonly policy?: EgressPolicy;
}

/**
 * Whether the kill switch is set. A presence check over a non-empty
 * value, RAW: an empty value is the absence of a value, which is this
 * repository's rule for environment values everywhere else, and the
 * whitespace a value carries is part of the value the operator set -
 * the switch is never disarmed by trimming it.
 */
function killSwitchIsSet(env: NodeJS.ProcessEnv): boolean {
  const value = env[CONSENT_STAMP_KILL_ENV];
  return value !== undefined && value !== "";
}

/**
 * Whether the operator granted egress consent. A value that cannot be
 * parsed is NOT a grant: the default is the refusal, so an unreadable
 * grant reads as no grant rather than as a yes.
 */
function consentIsGranted(env: NodeJS.ProcessEnv): boolean {
  const raw = env[CONSENT_STAMP_ENV];
  if (raw === undefined || raw === "") return false;
  try {
    return parseBool(raw, false, CONSENT_STAMP_ENV);
  } catch {
    return false;
  }
}

/** A refusal, with the class named in both sentences. */
function withheld(
  payloadClass: string,
  cause: string,
  secretIdentifiers: ReadonlyArray<string> = [],
): ConsentStampWithheld {
  const reason = `${payloadClass} were withheld: ${cause}`;
  return Object.freeze({
    outcome: CONSENT_STAMP_OUTCOME.withheld,
    payloadClass,
    detail: `egress consent withheld for ${payloadClass}: ${cause}.`,
    reason,
    secretIdentifiers: Object.freeze([...secretIdentifiers]),
  });
}

/**
 * Stamp a payload for egress, or refuse it.
 *
 * Pure with respect to the filesystem: it reads no file and writes none.
 * The only inputs are the payload, the class the caller names for it, the
 * site it is destined for and the environment the consent is read from.
 */
export function stampEgressConsent<T>(request: ConsentStampRequest<T>): ConsentStampVerdict<T> {
  const env = request.env ?? process.env;
  const payloadClass = request.payloadClass;

  // The kill switch, FIRST. Whatever the grant says, and whatever the
  // payload would have been.
  if (killSwitchIsSet(env)) {
    return withheld(
      payloadClass,
      `the egress consent kill switch (${CONSENT_STAMP_KILL_ENV}) is set, and no environment value re-enables it`,
    );
  }

  // The grant. Without one there is no consent to record. The refusal
  // separates an ABSENT grant from an UNRECOGNIZED one: telling an
  // operator who set the variable to set it would have them re-run the
  // instruction that already failed, so a value that is not a granting
  // value is named as the problem, with the granting spellings beside it.
  if (!consentIsGranted(env)) {
    const rawGrant = env[CONSENT_STAMP_ENV];
    const cause =
      rawGrant === undefined || rawGrant === ""
        ? `no egress consent is recorded; set ${CONSENT_STAMP_ENV} to grant it`
        : `${CONSENT_STAMP_ENV} is set to an unrecognized value; ` +
          `only ${CONSENT_STAMP_GRANT_VALUES.map((v) => JSON.stringify(v)).join(" or ")} grants consent`;
    return withheld(payloadClass, cause);
  }

  // The redaction. A stamp carries what would ACTUALLY leave, so the
  // shared guard runs over the payload before the stamp is issued - and
  // a guard refusal withholds the stamp rather than issuing one that
  // would have to be revoked.
  const scanned = redactForEgress(request.site, request.payload, request.policy ?? {});
  if (scanned.outcome !== EGRESS_OUTCOME.released) {
    return withheld(payloadClass, scanned.detail, scanned.secretIdentifiers);
  }
  return Object.freeze({
    outcome: CONSENT_STAMP_OUTCOME.stamped,
    payloadClass,
    payload: scanned.payload,
    redacted: scanned.redacted,
    detail:
      `egress consent stamped for ${payloadClass}: the payload is cleared to leave` +
      `${scanned.redacted ? " with secret-shaped content redacted" : ""}.`,
  });
}
