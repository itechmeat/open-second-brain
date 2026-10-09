/**
 * Tag syntax validation for COMPOSED frontmatter tags (trust-surface-
 * hardening wave; kanban t_11ee559f).
 *
 * The rule itself lives in `src/core/tags.ts` (`isObsidianTagValue`,
 * derived from the index's `TAG_RE`) - one spelling, consumed here,
 * never redefined. This module adds the typed refusal the tag composers
 * raise: caller-controlled input that fails the shared rule is rejected
 * with the offending FIELD named, shaped like `SchemaVocabularyError`
 * (stable error name plus structured `field` / `token`; the message
 * carries the field and the rule, never an ad-hoc sentence).
 */

import { isObsidianTagValue } from "../tags.ts";

export { isObsidianTagValue };

/**
 * The rule text every refusal carries, hoisted once: a tag value starts
 * with a letter or underscore and continues with letters, numbers,
 * dashes, underscores, or slashes - never only digits, never a leading
 * slash, never a space or other special.
 */
const TAG_VALUE_RULE_TEXT =
  "must start with a letter or underscore and contain only letters, numbers, dashes, underscores, or slashes (never only digits)";

/** Typed refusal for a composed tag value that fails the shared rule. */
export class TagSyntaxError extends Error {
  readonly field: string;
  readonly token: unknown;

  constructor(field: string, token: unknown, message: string) {
    super(`${field}: ${message}`);
    this.name = "TagSyntaxError";
    this.field = field;
    this.token = token;
  }
}

/**
 * Return `value` when it satisfies the shared tag rule; otherwise throw
 * {@link TagSyntaxError} naming `field`. Composers call this on every
 * segment they interpolate into a tag.
 */
export function requireObsidianTagValue(value: string, field: string): string {
  if (!isObsidianTagValue(value)) {
    throw new TagSyntaxError(field, value, TAG_VALUE_RULE_TEXT);
  }
  return value;
}
