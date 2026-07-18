/**
 * Canonicalization kernel - the one place entity identity is computed.
 *
 * Shared by the registry (duplicate refusal, alias resolution), the
 * doctor lints, search alias expansion, and the fact-extraction router,
 * so every consumer compares like with like. Same normalization shape
 * as `extractEntities` in src/core/search/entities.ts: NFC, lowercase,
 * collapsed whitespace.
 */

/** NFC-normalise, trim, collapse whitespace runs, lowercase. */
export function normalizeEntityName(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Validate an entity category: a lowercase kebab-ish slug with no path
 * separators, traversal, or whitespace. Lowercases the input so
 * `People` and `people` are the same category.
 */
export function validateEntityCategory(raw: string): string {
  const category = raw.normalize("NFC").trim().toLowerCase();
  if (!category) throw new Error("entity category must not be empty");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(category)) {
    throw new Error(
      `entity category must be a lowercase slug ([a-z0-9-], starting alphanumeric): ${JSON.stringify(raw)}`,
    );
  }
  return category;
}

/**
 * The identity key one canonical entity owns: `<category>:<normalized name>`.
 * Two files claiming the same key are duplicates by definition.
 */
export function entityIdentityKey(category: string, name: string): string {
  return `${validateEntityCategory(category)}:${normalizeEntityName(name)}`;
}

// ----- Label quality gate (A1 / t_657b365e) ---------------------------------
//
// `normalizeEntityName` above stays byte-stable: it is the identity kernel
// and its output feeds `entityIdentityKey`, so every currently-valid clean
// label must key identically to before. The label QUALITY pass lives here as
// a separate step applied BEFORE `normalizeEntityName` at every label-intake
// boundary (entity creation, fact-extract anchoring, atomic-facts anchoring):
// it strips Markdown decoration and surrounding punctuation, then rejects
// structurally-junk labels. Junk detection is STRUCTURAL only (Unicode
// property classes, never a natural-language word list); the sole vocabulary
// source is the operator-supplied denylist threaded in by the caller.

/**
 * Upper bound on a sanitized label's length. A defensible ceiling: real
 * entity names are short, and anything past this is a pasted blob, not a
 * label. Exported so callers and tests share one source of truth.
 */
export const ENTITY_LABEL_MAX_LENGTH = 200;

/** Leading Markdown heading marker: one-to-six `#` then required space/tab. */
const HEADING_PREFIX_RE = /^#{1,6}[ \t]+/;

/**
 * Matched Markdown emphasis/code wrappers, longest opener first so `**`
 * is peeled before `*`. One matched pair is removed per sanitise pass;
 * the outer loop re-runs until the label stops changing.
 */
const EMPHASIS_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ["**", "**"],
  ["__", "__"],
  ["*", "*"],
  ["_", "_"],
  ["`", "`"],
] as const;

/** A leading run of Unicode punctuation (surrounding, not internal). */
const LEADING_PUNCT_RE = /^\p{P}+/u;
/** A trailing run of Unicode punctuation (surrounding, not internal). */
const TRAILING_PUNCT_RE = /\p{P}+$/u;
/** At least one letter or digit in ANY script - the "carries meaning" test. */
const HAS_LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

/** Peel one matched emphasis/code wrapper pair, if present. */
function stripSurroundingEmphasis(s: string): string {
  for (const [open, close] of EMPHASIS_WRAPPERS) {
    if (s.length >= open.length + close.length + 1 && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(open.length, s.length - close.length).trim();
    }
  }
  return s;
}

/**
 * Strip surrounding Markdown emphasis/heading decoration and surrounding
 * (never internal) punctuation from a raw label, iterating until stable.
 *
 * Examples: `**Foo**` -> `Foo`, `# Heading` -> `Heading`, `_bar_` -> `bar`,
 * `(baz)` -> `baz`, `Foo.` -> `Foo`. Internal punctuation is preserved, so
 * `Node.js`, `e.g`, and `C++` survive. NFC-normalises and trims first so a
 * clean label (`Ada`, `Open Second Brain`, `café`, `Ада`) is returned
 * byte-identical to `raw.trim()` - the backward-compatibility guarantee for
 * every currently-clean label.
 */
export function sanitizeEntityLabel(raw: string): string {
  let s = raw.normalize("NFC").trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(HEADING_PREFIX_RE, "").trim();
    s = stripSurroundingEmphasis(s);
    s = s.replace(LEADING_PUNCT_RE, "").replace(TRAILING_PUNCT_RE, "").trim();
  }
  return s;
}

/** Why a label was rejected by {@link validateEntityLabel}. */
export type EntityLabelInvalidReason = "empty" | "too-long" | "no-letter-or-digit" | "denylisted";

export interface EntityLabelValidation {
  readonly valid: boolean;
  readonly reason?: EntityLabelInvalidReason;
}

export interface ValidateEntityLabelOptions {
  /**
   * Operator-supplied denylist of exact labels, ALREADY normalised via
   * `normalizeEntityName` (the comparison is post-normalization). The only
   * vocabulary source; empty/absent means no name-based rejection.
   */
  readonly denylist?: ReadonlySet<string>;
}

/**
 * Validate an already-sanitized label. Structural rejections only, plus the
 * operator denylist:
 *   - `empty`               - nothing survived sanitisation;
 *   - `too-long`            - exceeds {@link ENTITY_LABEL_MAX_LENGTH};
 *   - `no-letter-or-digit`  - no `\p{L}`/`\p{N}` in any script (pure
 *                             punctuation/symbols);
 *   - `denylisted`          - normalised form is in the operator denylist.
 *
 * The single source of truth for label validity - creation (typed error),
 * anchoring (logged skip), doctor, and prune all route through it.
 */
export function validateEntityLabel(
  sanitized: string,
  opts: ValidateEntityLabelOptions = {},
): EntityLabelValidation {
  if (sanitized.length === 0) return { valid: false, reason: "empty" };
  if (sanitized.length > ENTITY_LABEL_MAX_LENGTH) return { valid: false, reason: "too-long" };
  if (!HAS_LETTER_OR_DIGIT_RE.test(sanitized))
    return { valid: false, reason: "no-letter-or-digit" };
  if (opts.denylist && opts.denylist.has(normalizeEntityName(sanitized))) {
    return { valid: false, reason: "denylisted" };
  }
  return { valid: true };
}

/** Convenience boolean wrapper over {@link validateEntityLabel}. */
export function isValidEntityLabel(
  sanitized: string,
  opts: ValidateEntityLabelOptions = {},
): boolean {
  return validateEntityLabel(sanitized, opts).valid;
}

/** Typed error raised when a label is rejected at a creation boundary. */
export class InvalidEntityLabelError extends Error {
  readonly reason: EntityLabelInvalidReason;
  readonly raw: string;
  readonly sanitized: string;
  constructor(raw: string, sanitized: string, reason: EntityLabelInvalidReason) {
    super(
      `invalid entity label ${JSON.stringify(raw)} (${reason}): ` +
        `sanitised form ${JSON.stringify(sanitized)} does not pass the label quality gate`,
    );
    this.name = "InvalidEntityLabelError";
    this.reason = reason;
    this.raw = raw;
    this.sanitized = sanitized;
  }
}

/**
 * Sanitise `raw` and assert it passes the quality gate, returning the
 * sanitized label for storage. Throws {@link InvalidEntityLabelError} on
 * rejection - the creation-boundary contract (no silent drop).
 */
export function assertValidEntityLabel(raw: string, opts: ValidateEntityLabelOptions = {}): string {
  const sanitized = sanitizeEntityLabel(raw);
  const verdict = validateEntityLabel(sanitized, opts);
  if (!verdict.valid) {
    throw new InvalidEntityLabelError(raw, sanitized, verdict.reason!);
  }
  return sanitized;
}

/**
 * Normalised match forms for an entity's labels (name + aliases): sanitise
 * each, drop the structurally-invalid ones, then normalise the survivors.
 * The shared anchoring kernel so fact-extract and atomic-facts compare
 * facts against clean, valid label forms only. Pure - no I/O, no logging.
 */
export function entityMatchForms(
  rawForms: ReadonlyArray<string>,
  opts: ValidateEntityLabelOptions = {},
): string[] {
  const out: string[] = [];
  for (const raw of rawForms) {
    const sanitized = sanitizeEntityLabel(raw);
    if (!isValidEntityLabel(sanitized, opts)) continue;
    out.push(normalizeEntityName(sanitized));
  }
  return out;
}
