/**
 * Structural quality gate for taste signals (v0.10.16).
 *
 * Returns a `severity` of `ok | warn | reject` plus a list of
 * structural reasons. The detector is **language-agnostic by
 * construction**: it never consults a vocabulary list, stopword set,
 * unit dictionary, or any per-language data. All checks operate on
 * codepoint shape - digit presence, operator-shape character
 * presence, token count, single-character token ratio.
 *
 * The intent is to reject obviously unusable principles (empty,
 * single token) and warn on principles that are structurally weak
 * (no measurable outcome, mostly single-character filler, too long
 * to be remembered) without ever encoding "vague" words. A rule
 * like `"be careful"` and a rule like `"<some-language>-equivalent
 * of be-careful"` must be treated identically - the detector cannot
 * tell them apart and that is the point.
 */

/** Length thresholds. Tunable; chosen by structural feel. */
const MAX_CHARS = 500;
const MAX_TOKENS = 80;

/**
 * Above this ratio of single-character alphanumeric tokens to total
 * tokens, the principle is flagged as filler. 0.4 means "if more
 * than 40% of tokens are single letters / digits, the rule is too
 * sparse to be testable".
 */
const FILLER_RATIO_THRESHOLD = 0.4;

/** Operator-shape characters. Universal ASCII relational operators. */
const OPERATOR_CHARS_RE = /[<>=%]/;

/**
 * Digit codepoint test. `\d` with the `u` flag matches `[0-9]` only
 * in most engines; we want the broadest sense, so we also test the
 * Unicode "Number" property via the `\p{N}` escape.
 */
const NUMBER_CODEPOINT_RE = /[\p{N}]/u;

/**
 * Single-character alphanumeric token shape: exactly one codepoint
 * that is a Unicode letter or number. Punctuation, symbols, and
 * whitespace fall out because of the `\p{L}|\p{N}` constraint.
 */
const SINGLE_ALNUM_TOKEN_RE = /^[\p{L}\p{N}]$/u;

/**
 * Punctuation stripper. Removes anything that is NOT a letter,
 * number, or whitespace - so the token splitter only sees the
 * meaningful content. Codepoint shape only; no Latin assumption.
 */
const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

export interface RuleQualityResult {
  /**
   * Numeric score in `[0, 1]`. Higher is healthier. The score is
   * informational - `severity` is the gate consumers act on.
   */
  readonly score: number;
  /** Gate verdict. */
  readonly severity: "ok" | "warn" | "reject";
  /** Structural reasons that fired during the check. */
  readonly reasons: ReadonlyArray<string>;
}

export function assessRuleQuality(principle: string): RuleQualityResult {
  const reasons: string[] = [];

  // 1. Empty / whitespace-only -> reject.
  const trimmed = principle.trim();
  if (trimmed.length === 0) {
    return Object.freeze({
      score: 0,
      severity: "reject" as const,
      reasons: Object.freeze(["empty"]),
    });
  }

  // 2. Tokenise on whitespace after stripping punctuation. We keep
  //    the original string for character-presence checks (operator
  //    chars and digits can live inside or next to punctuation).
  const stripped = trimmed.replace(PUNCT_RE, " ");
  const tokens = stripped.split(/\s+/u).filter((t) => t.length > 0);

  if (tokens.length <= 1) {
    return Object.freeze({
      score: 0,
      severity: "reject" as const,
      reasons: Object.freeze(["single-token"]),
    });
  }

  // 3. Length warnings.
  if (trimmed.length > MAX_CHARS || tokens.length > MAX_TOKENS) {
    reasons.push("too-long");
  }

  // 4. Measurable-signal: any digit anywhere OR any operator char.
  //    Both checks operate on raw codepoints - language-blind.
  const hasDigit = NUMBER_CODEPOINT_RE.test(trimmed);
  const hasOperator = OPERATOR_CHARS_RE.test(trimmed);
  if (!hasDigit && !hasOperator) {
    reasons.push("no-measurable-signal");
  }

  // 5. Filler ratio: single-character alphanumeric tokens are
  //    presumed filler at this granularity.
  const singleCharCount = tokens.filter((t) => SINGLE_ALNUM_TOKEN_RE.test(t)).length;
  const fillerRatio = singleCharCount / tokens.length;
  if (fillerRatio > FILLER_RATIO_THRESHOLD) {
    reasons.push("filler-ratio-high");
  }

  // 6. Score: 1.0 minus the count of fired reasons divided by the
  //    number of warning checks (three: too-long, no-measurable-
  //    signal, filler-ratio-high). Clamped to [0, 1].
  const NUM_WARN_CHECKS = 3;
  const score = Math.max(0, Math.min(1, 1 - reasons.length / NUM_WARN_CHECKS));

  const severity = reasons.length > 0 ? "warn" : "ok";

  return Object.freeze({
    score,
    severity,
    reasons: Object.freeze(reasons.slice()),
  });
}
