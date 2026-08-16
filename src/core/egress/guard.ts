/**
 * The one call every export path makes before its bytes leave the vault.
 *
 * ## Why truncation is a REFUSAL here and not elsewhere
 *
 * `redactRawOutput` fails closed on oversized input: it scans the prefix
 * that fits the window, drops the tail, and stamps
 * `SCAN_TRUNCATED_MARKER` so the artifact reads as unverified rather than
 * clean. Two consumers already answer that differently, and both are
 * right for where they sit.
 *
 * `src/mcp/artifact-store.ts` disables the window entirely
 * (`maxInput: Number.POSITIVE_INFINITY`). Its whole job is to preserve a
 * full tool payload for a later fetch, its destination is a dot-directory
 * INSIDE the vault, and truncating would silently clip a payload the
 * agent is about to ask for by id. Nothing crosses a trust boundary, so
 * scanning everything and keeping everything is the honest answer.
 *
 * An export is the opposite case on both axes. The bytes leave the
 * machine, and the operator cannot inspect what they no longer have. So
 * this guard neither truncates silently nor scans without bound: it keeps
 * the window - an unbounded scan over an operator-supplied payload is the
 * denial-of-service bound the window exists for - and turns the marker
 * into a refusal. Writing a file that says "partially scanned" at the
 * bottom is the misleading success this project forbids: the export
 * either scanned its payload or it did not go.
 *
 * The refusal is per PAYLOAD, not per export, because the scan runs over
 * each string leaf rather than the serialised document. A whole-vault
 * bundle far larger than the window still exports; a single field larger
 * than the window is what refuses, which is a field no legitimate note
 * carries.
 *
 * ## What it redacts, and what it does not
 *
 * `redactTokens` is ON. At an egress boundary the asymmetry inverts: a
 * false positive mangles an id in a copy while the vault still holds the
 * original, and a false negative is unrecoverable because the bytes are
 * gone. That is the reverse of the receipt boundary the redactor's
 * defaults are tuned for, which is why the flag is set here and not
 * there.
 *
 * `redactInfra` is OFF, and only its credential half
 * (`redactUrlCredentials`) is taken. A `user:pass@host` URL is a
 * credential; a `host:port` or a public IP in an authored note is a
 * reference a portable knowledge bundle has to keep. Redacting those
 * would break the interchange contract for a class of exposure the
 * operator already controls by choosing the destination. That gap is
 * stated here rather than left to be discovered.
 *
 * ## Identifiers are refused, never rewritten
 *
 * Redaction replaces a value. That is harmless for a payload - the vault
 * still holds the original - and destructive for an IDENTIFIER: a redacted
 * filename merges every page whose name matched onto one bundle path, a
 * redacted mapping key renames the field, and a redacted path segment
 * hands a support person a path that does not exist. So `redactStructured`
 * reports secret-shaped identifiers instead of replacing them, and this
 * guard turns that report into the second refusal
 * ({@link EGRESS_OUTCOME.refusedSecretIdentifier}), on the same reasoning
 * as the truncation one: an export that cannot be made safe does not go.
 *
 * The cost is a false refusal on a legitimately-named file that begins
 * with a vendor credential prefix. That is recoverable by renaming; a
 * merged page is not.
 */

import { MAX_REDACTOR_INPUT, redactStructured, type RedactRawOutputOptions } from "../redactor.ts";
import { EGRESS_SITES, type EgressSiteId } from "./registry.ts";

/** How a payload offered to the boundary came back. */
export const EGRESS_OUTCOME = Object.freeze({
  /** Scanned in full and cleared to be written. */
  released: "released",
  /** Some field exceeded the scan window, so the payload is unverified. */
  refusedScanTruncated: "refused_scan_truncated",
  /**
   * An identifier - a filename, an id, a mapping key - is secret-shaped.
   * Redacting it is not available (it would merge the pages a path names,
   * or rename a field), so the payload is refused instead.
   */
  refusedSecretIdentifier: "refused_secret_identifier",
} as const);

export type EgressOutcome = (typeof EGRESS_OUTCOME)[keyof typeof EGRESS_OUTCOME];

export const EGRESS_OUTCOMES: ReadonlyArray<EgressOutcome> = Object.freeze([
  EGRESS_OUTCOME.released,
  EGRESS_OUTCOME.refusedScanTruncated,
  EGRESS_OUTCOME.refusedSecretIdentifier,
]);

/** Takes `unknown`: an outcome may be read back out of a serialised result. */
export function isEgressOutcome(value: unknown): value is EgressOutcome {
  return typeof value === "string" && (EGRESS_OUTCOMES as ReadonlyArray<string>).includes(value);
}

export interface EgressReleased<T> {
  readonly outcome: typeof EGRESS_OUTCOME.released;
  /** The redacted payload, same shape as the input. */
  readonly payload: T;
  /** True when anything changed, so the verb can say the copy differs. */
  readonly redacted: boolean;
}

export interface EgressRefused {
  readonly outcome:
    | typeof EGRESS_OUTCOME.refusedScanTruncated
    | typeof EGRESS_OUTCOME.refusedSecretIdentifier;
  /** Operator-facing sentence naming the verb and what to do about it. */
  readonly detail: string;
  /**
   * The tree locations the structural scan reported as secret-shaped
   * identifiers, already inside {@link detail} and carried structurally as
   * well. Empty on the truncation arm.
   *
   * A caller composing its own prefix around `detail` has to know WHICH
   * identifier was refused before it can decide what is safe to say. The
   * transcript export is the case: it named each refused record by its
   * `session_id`, which is the transcript's basename - so when the
   * basename was itself the secret-shaped identifier, the refusal printed
   * the exact value it had just declined to write. Reading the list is
   * what lets that caller withhold the name on that one branch and keep
   * printing it on every other.
   */
  readonly secretIdentifiers: ReadonlyArray<string>;
}

/**
 * Released or refused. A union rather than a nullable payload, so a
 * caller cannot write a refusal's empty text by forgetting a check.
 */
export type EgressVerdict<T> = EgressReleased<T> | EgressRefused;

/**
 * The redaction policy for every path that writes outside the vault. One
 * constant, because six paths with six policies is the drift this unit
 * exists to remove.
 */
const EGRESS_REDACTION_OPTIONS: RedactRawOutputOptions = Object.freeze({
  redactTokens: true,
  redactUrlCredentials: true,
});

/** Bytes, rendered for an operator who has to act on the number. */
const SCAN_WINDOW_MIB = MAX_REDACTOR_INPUT / (1024 * 1024);

/**
 * Emitted on stderr by every verb whose payload the guard changed, so
 * stdout stays byte-identical and parseable. An export that quietly
 * differs from the vault it came from is a surprise the operator finds
 * later, in the copy they already shared.
 */
export const EGRESS_REDACTION_NOTICE =
  "note: secret-shaped content was redacted; this export no longer matches the vault byte for byte\n";

/**
 * What a call site may vary about the one policy above.
 *
 * Deliberately not a second policy constant: the redaction options stay
 * single, and this names the one decision that cannot be answered once for
 * every site because it depends on WHERE the payload's identifiers were
 * named rather than on where they are going.
 */
export interface EgressPolicy {
  /**
   * The payload's identifiers were named outside this vault, so judge them
   * with the full bare-token detector rather than vendor prefixes alone.
   * Set by the transcript corpus and nothing else - see
   * `foreignIdentifierCarriesSecret` in the redactor for why the default
   * is right for every vault-authored export.
   */
  readonly foreignIdentifiers?: boolean;
}

/**
 * Redact `payload` for `site`, or refuse it. The payload may be a string
 * or any JSON-shaped tree; see `redactStructured` for why the tree form
 * exists rather than a pass over serialised bytes.
 */
export function redactForEgress<T>(
  site: EgressSiteId,
  payload: T,
  policy: EgressPolicy = {},
): EgressVerdict<T> {
  const scanned = redactStructured(payload, {
    ...EGRESS_REDACTION_OPTIONS,
    ...(policy.foreignIdentifiers === true ? { foreignIdentifiers: true } : {}),
  });
  if (scanned.truncated) {
    return {
      outcome: EGRESS_OUTCOME.refusedScanTruncated,
      secretIdentifiers: Object.freeze([]),
      detail:
        `${EGRESS_SITES[site].verb} refused to write: a field exceeded the redactor ` +
        `scan window (${SCAN_WINDOW_MIB} MiB), so only part of it was scanned and this ` +
        "export cannot be reported as clean. Nothing was written. Shrink the oversized " +
        "field or export a narrower selection.",
    };
  }
  if (scanned.secretIdentifiers.length > 0) {
    return {
      outcome: EGRESS_OUTCOME.refusedSecretIdentifier,
      secretIdentifiers: scanned.secretIdentifiers,
      detail:
        `${EGRESS_SITES[site].verb} refused to write: an identifier is secret-shaped, and an ` +
        "identifier is never rewritten - a redacted filename merges the pages it names and a " +
        "redacted mapping key renames the field, so redacting here would destroy content " +
        "rather than protect it. Nothing was written. Rename or exclude what these tree " +
        `locations point at, then re-run: ${scanned.secretIdentifiers.join(", ")}. ` +
        "(Locations, not values: the identifier is the secret.)",
    };
  }
  return {
    outcome: EGRESS_OUTCOME.released,
    payload: scanned.value as T,
    redacted: scanned.redacted,
  };
}

/**
 * Redact a configuration mapping for a surface outside the vault - the
 * config snapshot in `export-config`, `second_brain_status` over MCP, and
 * the OpenClaw status tool.
 *
 * This is what `config.ts`'s `redactMapping` became. That copy matched
 * five substrings against key NAMES only and never inspected a value, so
 * a credential under a name it did not recognise passed straight through.
 * Both halves now come from the shared redactor.
 *
 * No refusal arm: a status tool's answer is not a file leaving the
 * machine, and a config value past the scan window carries the marker in
 * place, which is visible rather than silent. For the same reason it does
 * not act on `secretIdentifiers`: the resolved PATHS are what this surface
 * exists to report, they are returned verbatim, and a credential stored as
 * a directory name is left visible rather than turned into a status call
 * that refuses to answer. Path values reach the caller unchanged, which is
 * the point - the previous behaviour replaced any 24-character segment of
 * the operator's own path with a placeholder.
 */
export function redactConfigMapping(
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return redactStructured(data, EGRESS_REDACTION_OPTIONS).value as Record<string, unknown>;
}
