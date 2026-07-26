/**
 * Seam 2 - "record what you were derived from, verify on read".
 *
 * Three units of the context-integrity-gates wave need the same
 * mechanism and would otherwise each invent it: a context pack must
 * verify the vault state it was built from (B), an embedding store must
 * verify the model, dimension, and sqlite-vec ABI it was written against
 * (E), and a vault root must verify the identity marker it was
 * bootstrapped with (J).
 *
 * The mechanism is: a caller records a map of opaque string tokens at
 * write time, presents the live tokens at read time, and this module
 * reports which fields drifted. It is deliberately DOMAIN-AGNOSTIC -
 * every field name is supplied by the caller, so nothing here mentions a
 * generation counter, an embedding dimension, or a vault id. A token is
 * an opaque string; this module never parses, orders, or interprets one,
 * and never inspects natural language.
 *
 * ## `null` means "not recorded"
 *
 * A token map is `Record<string, string | null>`. An absent key and an
 * explicit `null` are the SAME condition - the side did not record that
 * field - so a legacy artifact written before a field existed compares
 * as unrecorded rather than as a spurious drift against the empty
 * string. Two unrecorded sides are not a finding. An empty string, by
 * contrast, IS a recorded value and is distinct from `null`.
 *
 * ## The gate decides where refusal begins, and `off` really is off
 *
 * {@link compareStamps} is the pure comparison and always reports what
 * it finds. {@link checkStamp} is the gated form: under
 * {@link GATE_MODE.off} it does not compare at all and returns no
 * evidence, so a caller wired to the gate structurally CANNOT emit a new
 * field, warning, or refusal while the gate is off. That is what makes
 * the byte-identical-when-absent contract mechanical rather than a
 * discipline every consumer has to re-implement. A caller that wants a
 * diagnostic irrespective of the operator's gate calls
 * {@link compareStamps} directly and says so.
 */

/**
 * The three-mode gate. `off` disables the check, `warn` reports drift
 * without refusing, `fail` refuses. Closed by design: every additional
 * mode multiplies the consuming test matrix, and units whose condition
 * is unambiguous are expected to stay binary rather than grow a fourth.
 */
export const GATE_MODE = Object.freeze({
  off: "off",
  warn: "warn",
  fail: "fail",
} as const);

/**
 * Gate-mode union. A consumer switching over it with a `never`-typed
 * `default` arm fails to compile if a mode is ever added.
 */
export type GateMode = (typeof GATE_MODE)[keyof typeof GATE_MODE];

/**
 * The modes in increasing order of strictness. Ordered (not a `Set`) so
 * config-error messages list them the same way every time.
 */
export const GATE_MODES: ReadonlyArray<GateMode> = Object.freeze([
  GATE_MODE.off,
  GATE_MODE.warn,
  GATE_MODE.fail,
]);

/** Narrow an unvalidated config or argument value to a {@link GateMode}. */
export function isGateMode(value: unknown): value is GateMode {
  return typeof value === "string" && (GATE_MODES as ReadonlyArray<string>).includes(value);
}

/**
 * The tokens one side of a comparison recorded. Keys are caller-owned
 * field names; values are opaque strings, or `null` for "this side did
 * not record that field".
 */
export type StampTokens = Readonly<Record<string, string | null>>;

/** One field whose recorded token no longer matches the live one. */
export interface StampMismatch {
  /** The caller-supplied field name that drifted. */
  readonly field: string;
  /** What was recorded when the artifact was derived. */
  readonly expected: string | null;
  /** What is live now. */
  readonly actual: string | null;
}

/** Outcome of a gated comparison. */
export const STAMP_VERDICT = Object.freeze({
  /** Nothing to report: the stamps matched, or the gate is off. */
  pass: "pass",
  /** Drift found; the gate reports it and the caller proceeds. */
  warn: "warn",
  /** Drift found; the gate refuses. */
  fail: "fail",
} as const);

export type StampVerdict = (typeof STAMP_VERDICT)[keyof typeof STAMP_VERDICT];

/** Result of {@link checkStamp}: the verdict plus the evidence behind it. */
export interface StampCheck {
  /** The mode the check ran under, echoed so a report can name it. */
  readonly mode: GateMode;
  readonly verdict: StampVerdict;
  /** Empty whenever the verdict is `pass` - including under `off`. */
  readonly mismatches: ReadonlyArray<StampMismatch>;
}

/** Rendered for a side that recorded nothing, so a gap is never blank. */
const UNRECORDED_TOKEN = "<unrecorded>";

/** Runs of any whitespace; collapsed so a rendered mismatch is one line. */
const WHITESPACE_RUN_RE = /\s+/g;

/** An absent key and an explicit `null` are the same condition. */
function tokenOf(tokens: StampTokens, field: string): string | null {
  const value = tokens[field];
  return value === undefined ? null : value;
}

/**
 * Compare two token maps and report every field that drifted.
 *
 * The compared field set is the union of both maps' keys, sorted by code
 * unit so the result is byte-identical across runs, engines, and locales
 * regardless of the order the caller built either map in.
 *
 * This is the ungated form: it always compares and always reports.
 */
export function compareStamps(
  expected: StampTokens,
  actual: StampTokens,
): ReadonlyArray<StampMismatch> {
  const fields = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted();
  const mismatches: StampMismatch[] = [];
  for (const field of fields) {
    const before = tokenOf(expected, field);
    const now = tokenOf(actual, field);
    if (before === now) continue;
    mismatches.push(Object.freeze({ field, expected: before, actual: now }));
  }
  return Object.freeze(mismatches);
}

/**
 * Compare under an operator-chosen gate.
 *
 * Under {@link GATE_MODE.off} no comparison is performed and no evidence
 * is returned, so a gated caller emits nothing at all - see the module
 * docblock. Otherwise the drift is reported and the mode decides whether
 * the verdict is a warning or a refusal; the caller owns what it does
 * with each.
 *
 * A mode outside the closed vocabulary THROWS. The types stop most of
 * them, but a value crossing a `JSON.parse` or an `as` cast does not
 * meet the compiler, and the previous `mode === fail ? fail : warn`
 * shape resolved every such value to the SOFTEST verdict - an
 * unrecognised token silently becoming a warning is indistinguishable
 * from an operator who asked for one.
 */
export function checkStamp(expected: StampTokens, actual: StampTokens, mode: GateMode): StampCheck {
  if (!isGateMode(mode)) {
    throw new Error(
      `unknown gate mode ${JSON.stringify(mode)}; expected one of ${GATE_MODES.join(", ")}`,
    );
  }
  if (mode === GATE_MODE.off) {
    return Object.freeze({
      mode,
      verdict: STAMP_VERDICT.pass,
      mismatches: Object.freeze([]) as ReadonlyArray<StampMismatch>,
    });
  }
  const mismatches = compareStamps(expected, actual);
  const verdict =
    mismatches.length === 0
      ? STAMP_VERDICT.pass
      : mode === GATE_MODE.fail
        ? STAMP_VERDICT.fail
        : STAMP_VERDICT.warn;
  return Object.freeze({ mode, verdict, mismatches });
}

/**
 * Render one mismatch as a single English line:
 *
 *   `<field>: expected "<recorded>", actual <unrecorded>`
 *
 * Values are quoted so an empty recorded value is visible, and an
 * unrecorded side is named explicitly rather than rendered as a gap.
 * Shared by every consuming unit so three gates cannot grow three
 * spellings of the same refusal.
 */
export function formatStampMismatch(mismatch: StampMismatch): string {
  const field = collapse(mismatch.field);
  return `${field}: expected ${renderToken(mismatch.expected)}, actual ${renderToken(mismatch.actual)}`;
}

function renderToken(value: string | null): string {
  return value === null ? UNRECORDED_TOKEN : JSON.stringify(collapse(value));
}

function collapse(value: string): string {
  return value.replace(WHITESPACE_RUN_RE, " ").trim();
}
