/**
 * Seam 1 - the typed degradation notice channel.
 *
 * Across the read and delivery path this repository swallows failures in
 * bare `catch { continue }` arms and drops frontmatter lines the scanner
 * does not understand. The information is not merely unlogged: the agent
 * cannot tell a genuine miss from a broken mechanism. This module is the
 * one place those sites report to. It records WHAT degraded (`code`),
 * WHERE (`site`), on which artifact (`path`, when one is known), and the
 * concrete observation (`detail`).
 *
 * The channel carries diagnostics only. It never changes control flow: a
 * fail-soft caller emits a notice and continues exactly as before, so
 * conversion of a swallowing call site is behaviour-preserving and only
 * the trace is new.
 *
 * ## The code vocabulary is CLOSED by design
 *
 * `DegradationCode` is a union over a frozen table, not a free string.
 * The failure mode a typed diagnostic channel invites is becoming a
 * dumping ground - every call site inventing its own token until the
 * vocabulary is unreviewable and no consumer can switch on it. Two
 * properties prevent that here:
 *
 *   1. Adding a code is a deliberate edit of this file, reviewed against
 *      the unit that needs it. A caller cannot mint one in passing.
 *   2. A consumer switching over `DegradationCode` with a `never`-typed
 *      `default` arm gets a COMPILE error for an unhandled member, so a
 *      new code cannot silently fall through an existing renderer.
 *
 * Every member below is therefore annotated with the unit that owns it.
 * The seeded set covers exactly the units whose plan entries declare a
 * dependency on this seam (F, C, D, J). Units whose gate is a stamp
 * comparison rather than a swallowed failure (B, E) report through
 * `stamp.ts` instead and add nothing here.
 *
 * Nothing in this module inspects natural language. `detail` is operator
 * -supplied text passed through verbatim; the formatter templates it and
 * normalizes whitespace, and that is the whole of its processing.
 */

/**
 * Closed vocabulary of degradation conditions. Keys are camelCase for
 * call sites; values are the kebab-case tokens that appear in reports,
 * receipts, and MCP payloads.
 */
export const DEGRADATION_CODE = Object.freeze({
  /**
   * Unit F. The frontmatter scanner reached a line it cannot express as
   * a `key: value` pair (or a block-style list continuation) and dropped
   * it. Today this is structurally silent: the field simply never
   * reaches the parsed map.
   */
  frontmatterLineDropped: "frontmatter-line-dropped",
  /**
   * Unit F. A note's frontmatter could not be obtained at all because
   * the read failed. This is the condition behind the bare
   * `catch { continue }` arms on every frontmatter-reading walker.
   */
  frontmatterUnreadable: "frontmatter-unreadable",
  /**
   * Unit F. A vault walk could not descend into or stat an entry, so a
   * subtree is missing from the result. Distinct from
   * `frontmatterUnreadable`: nothing was parsed, an entire branch was
   * skipped.
   */
  vaultWalkEntrySkipped: "vault-walk-entry-skipped",
  /**
   * Unit C. Session continuation declined to link rather than guessing -
   * no candidate, an ambiguous set, or missing evidence. The abstention
   * is the correct outcome; the notice is what makes it visible instead
   * of indistinguishable from "nothing to link".
   */
  sessionLinkAbstained: "session-link-abstained",
  /**
   * Unit D. A lineage observation was not appended (writer-lock
   * contention or a failed read-modify-write) and is recorded as a named
   * gap rather than vanishing.
   */
  lineageObservationDropped: "lineage-observation-dropped",
  /**
   * Unit D. Ledger verification found a sequence gap or a hash-chain
   * break. Reported, never fatal: the read path stays fail-soft.
   */
  lineageChainBroken: "lineage-chain-broken",
  /**
   * Unit J. The resolved vault root carries no identity marker. An
   * absent marker cannot distinguish an old vault from a wrong root, so
   * this warns rather than refusing.
   */
  vaultMarkerAbsent: "vault-marker-absent",
  /**
   * Unit J. The resolved vault root carries a marker that does not match
   * the expected identity. Unambiguous, and therefore a refusal at the
   * write path rather than a warning.
   */
  vaultMarkerMismatch: "vault-marker-mismatch",
} as const);

/**
 * The closed union. A consumer that switches over this type with a
 * `never`-typed `default` arm fails to compile when a member is added
 * without a corresponding arm - which is the point of the closure.
 */
export type DegradationCode = (typeof DEGRADATION_CODE)[keyof typeof DEGRADATION_CODE];

/**
 * One named degradation. `path` is present only when the condition is
 * attributable to a concrete file or directory; the key is OMITTED (not
 * set to `undefined`) when it is not, so a serialized notice from a
 * path-less site carries no empty field.
 */
export interface DegradationNotice {
  /** What degraded, from the closed vocabulary. */
  readonly code: DegradationCode;
  /** Where it was observed - a function, verb, or subsystem name. */
  readonly site: string;
  /** The artifact it happened to, when one is known. */
  readonly path?: string;
  /** The concrete observation, in English, passed through verbatim. */
  readonly detail: string;
}

/** Construction input for {@link degradationNotice}. */
export interface DegradationNoticeInput {
  readonly code: DegradationCode;
  readonly site: string;
  readonly path?: string;
  readonly detail: string;
}

/**
 * A notice was constructed that could not name its own condition. This
 * throws rather than returning a placeholder record: a diagnostic
 * channel that emits blank diagnostics reproduces exactly the silent
 * failure it exists to remove.
 */
export class DegradationNoticeError extends Error {
  /** The offending field (`site`, `detail`, or `path`). */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`degradation notice: ${field}: ${message}`);
    this.name = "DegradationNoticeError";
    this.field = field;
  }
}

/** Runs of any whitespace, including the newlines a single line cannot carry. */
const WHITESPACE_RUN_RE = /\s+/g;

/** Rendered in place of a path only when one is known - see `formatDegradationNotice`. */
const PATH_OPEN = " (";
const PATH_CLOSE = ")";

function requireNonBlank(field: string, value: string): string {
  if (value.trim().length === 0) {
    throw new DegradationNoticeError(field, "must be a non-blank string");
  }
  return value;
}

/**
 * Build one frozen {@link DegradationNotice}, rejecting an input that
 * cannot name its condition. Use this at sites that RETURN a notice;
 * sites that accumulate into a collector should use
 * {@link emitDegradationNotice}.
 */
export function degradationNotice(input: DegradationNoticeInput): DegradationNotice {
  const site = requireNonBlank("site", input.site);
  const detail = requireNonBlank("detail", input.detail);
  // `path` is optional, so absence is legal - but a present-and-blank
  // path is a caller bug that would render as an empty `()` suffix.
  const path = input.path === undefined ? undefined : requireNonBlank("path", input.path);
  return Object.freeze({
    code: input.code,
    site,
    ...(path !== undefined ? { path } : {}),
    detail,
  });
}

/**
 * Build a notice and append it to `sink`, returning the same record.
 * This is the emit form used by the report types that already exist
 * (`IndexStats`, the doctor's `uncertain` list, MCP response fields):
 * the caller keeps one array and never repeats the push.
 *
 * A malformed input throws before anything is appended, so a sink never
 * holds a notice that cannot name its condition.
 */
export function emitDegradationNotice(
  sink: DegradationNotice[],
  input: DegradationNoticeInput,
): DegradationNotice {
  const notice = degradationNotice(input);
  sink.push(notice);
  return notice;
}

/**
 * Render a notice as exactly ONE English line:
 *
 *   `<code> at <site>: <detail>`
 *   `<code> at <site> (<path>): <detail>`
 *
 * Whitespace runs inside `site`, `path`, and `detail` collapse to single
 * spaces so a multi-line error message cannot break the one-line
 * contract that log, receipt, and doctor renderers depend on.
 */
export function formatDegradationNotice(notice: DegradationNotice): string {
  const site = collapse(notice.site);
  const detail = collapse(notice.detail);
  const where =
    notice.path === undefined ? "" : `${PATH_OPEN}${collapse(notice.path)}${PATH_CLOSE}`;
  return `${notice.code} at ${site}${where}: ${detail}`;
}

function collapse(value: string): string {
  return value.replace(WHITESPACE_RUN_RE, " ").trim();
}
