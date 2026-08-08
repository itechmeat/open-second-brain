/**
 * Canonicalization kernel - the one place entity identity is computed.
 *
 * Shared by the registry (duplicate refusal, alias resolution), the
 * doctor lints, search alias expansion, and the fact-extraction router,
 * so every consumer compares like with like. Same normalization shape
 * as `extractEntities` in src/core/search/entities.ts: NFC, lowercase,
 * collapsed whitespace - plus the quote-variant fold below.
 */

/** A run of whitespace of any kind, collapsed to one space. */
const WHITESPACE_RUN_RE = /\s+/g;

/**
 * The one form every typographic quote variant folds to. U+0027 is the
 * ASCII apostrophe, so the fold never rewrites an ASCII byte: a label
 * that is already ASCII keys exactly as it did before the fold existed.
 */
export const QUOTE_VARIANT_FOLD_TARGET = "'";

/**
 * U+02BC MODIFIER LETTER APOSTROPHE. It is a LETTER by general category
 * (`\p{Lm}`), so it is outside the punctuation classes below and needs
 * its own entry - and it is an apostrophe by function, which is why an
 * editor or a paste can substitute it for U+0027 in a label.
 */
const MODIFIER_LETTER_APOSTROPHE = "ʼ";

/**
 * Every typographic quote variant, DERIVED from Unicode general
 * categories rather than enumerated by hand: initial quote punctuation
 * (`\p{Pi}`), final quote punctuation (`\p{Pf}`), and the modifier-letter
 * apostrophe. The engine resolves the membership, so the rule tracks the
 * Unicode tables it names instead of a list that ages.
 *
 * The exact footprint is asserted exhaustively over the whole code point
 * space in `tests/core/brain/entities/quote-variant-fold.test.ts`, so a
 * widened class cannot land unmeasured.
 */
const QUOTE_VARIANT_RE = new RegExp(`[\\p{Pi}\\p{Pf}${MODIFIER_LETTER_APOSTROPHE}]`, "gu");

/**
 * Fold every typographic quote variant onto {@link QUOTE_VARIANT_FOLD_TARGET}.
 *
 * No Unicode normal form does this: NFC, NFD, NFKC and NFKD all leave
 * U+2019 exactly where it is, so `Taylor's` and `Taylor’s` were two
 * canonical entities in one registry, differing only in which key a text
 * editor happened to insert. Identity is the one place that distinction
 * carries no information, so this is where it is discarded - the same
 * kind of deliberate loss as lowercasing and whitespace collapse.
 */
export function foldQuoteVariants(raw: string): string {
  return raw.replace(QUOTE_VARIANT_RE, QUOTE_VARIANT_FOLD_TARGET);
}

/**
 * The kernel's shape pass, WITHOUT the quote fold: NFC, trim, collapse
 * whitespace runs, lowercase. Separated from {@link normalizeEntityName}
 * so {@link differsOnlyByQuoteVariant} can name the difference the fold
 * makes rather than re-deriving it from a second copy of these steps.
 */
function normalizeEntityShape(raw: string): string {
  return raw.normalize("NFC").trim().replace(WHITESPACE_RUN_RE, " ").toLowerCase();
}

/** NFC-normalise, trim, collapse whitespace runs, lowercase, fold quote variants. */
export function normalizeEntityName(raw: string): string {
  return foldQuoteVariants(normalizeEntityShape(raw));
}

/**
 * Registry code the quote-variant collision resolves its forward pointer
 * through, and the structural command that resolves it.
 *
 * Both live in this LEAF module rather than at the consumer, and the
 * `DIAGNOSTIC_SIGNALS` entry in `diagnostics.ts` is built from them, so
 * the string still has exactly one definition. The usual arrangement -
 * the consumer resolving `requireNextStep(code)` at module scope - is not
 * available to the REGISTRY: `next-step.ts` reads `diagnostics.ts`, which
 * reaches the entity registry through the doctor's entity checks and the
 * search query-expansion module, so a registry import of `next-step.ts`
 * closes an import cycle the architecture ratchet refuses
 * (`tests/core/architecture/import-cycles.test.ts`). This module imports
 * nothing, so both consumers can read it.
 *
 * The code's PRODUCER is `doctor/entity-checks.ts`, which spells it on the
 * finding for a collision the fold created; every doctor surface resolves
 * a finding's code through the rail (`nextCommandField` / `emitNextStep`),
 * which is how the other registered doctor codes reach an operator. The
 * registry's own refusals are thrown synchronously out of core and name
 * the command from {@link ENTITY_QUOTE_VARIANT_COLLISION_COMMAND} - the
 * same constant the registration is built from, so the two cannot drift.
 */
export const ENTITY_QUOTE_VARIANT_COLLISION_CODE = "entity-quote-variant-collision";
export const ENTITY_QUOTE_VARIANT_COLLISION_COMMAND = "o2b brain entity archive <name>";

/**
 * The one sentence naming WHY two labels that coexisted before the fold
 * cannot coexist after it. Written once here because three surfaces say
 * it - the registry's write refusal, the registry's ambiguity error, and
 * the doctor's finding - and an operator who meets it twice must read the
 * same words, or the two readings become two conditions.
 */
export const ENTITY_QUOTE_VARIANT_CAUSE =
  "the two differ only in typographic quote form and now resolve to one identity key";

/**
 * True when `a` and `b` are two spellings of one identity that ONLY the
 * quote fold unifies - they were distinct identities before it and are
 * one after it.
 *
 * This is the predicate a collision message asks so it can name the right
 * exit: a refusal an operator meets for the first time immediately after
 * an upgrade needs to say WHY two records that used to coexist no longer
 * can, and every other collision keeps the message it always had.
 */
export function differsOnlyByQuoteVariant(a: string, b: string): boolean {
  const shapeA = normalizeEntityShape(a);
  const shapeB = normalizeEntityShape(b);
  return shapeA !== shapeB && foldQuoteVariants(shapeA) === foldQuoteVariants(shapeB);
}

/**
 * True when ANY two of `labels` are one identity only the fold unifies.
 *
 * The n-ary form because a collision is a set of claimants, not a pair:
 * three files can claim one key, and a message that only ever compared
 * the first two would omit the cause on exactly the messiest vault.
 */
export function anyDiffersOnlyByQuoteVariant(labels: ReadonlyArray<string>): boolean {
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (differsOnlyByQuoteVariant(labels[i]!, labels[j]!)) return true;
    }
  }
  return false;
}

/**
 * The tail a collision message carries when, and only when, the labels
 * were distinct identities before the quote fold and are one after it.
 * Empty for every other collision, so the messages an operator already
 * knows are unchanged and the new sentence means exactly what it says:
 * this refusal is new, and here is why.
 *
 * Lives beside the predicate rather than at the registry because the
 * doctor's finding needs the same words - see
 * {@link ENTITY_QUOTE_VARIANT_CAUSE}.
 */
export function quoteVariantCollisionTail(...labels: ReadonlyArray<string>): string {
  if (!anyDiffersOnlyByQuoteVariant(labels)) return "";
  return (
    ` - ${ENTITY_QUOTE_VARIANT_CAUSE}; ` +
    `run ${ENTITY_QUOTE_VARIANT_COLLISION_COMMAND} on the record you do not keep`
  );
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
// `normalizeEntityName` above stays byte-stable for every label that
// carries no typographic quote variant: it is the identity kernel and its
// output feeds `entityIdentityKey`, so such a label must key identically to
// before. The quote fold is the ONE deliberate exception, its footprint is
// exactly the Unicode classes `foldQuoteVariants` names, and the corpus
// proof lives in tests/core/brain/entities/quote-variant-fold.test.ts. The
// label QUALITY pass lives here as
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
