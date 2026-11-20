/**
 * The key of one scope value of the scoped operator rules (`scoped-rules.ts`):
 * the rule a project, harness or host value is keyed by, and the rule a
 * record's stamped project is read back by (`record-origin.ts`, the topic
 * scopes). A leaf module, so the topic records and the record readers can
 * key a value without importing the scoped-rules reader and what it reads.
 */

export const SCOPED_RULE_KEY_MAX_CHARS = 64;

const NON_KEY_RUN = /[^\p{L}\p{M}\p{N}]+/gu;

/**
 * File key for one scope value: NFC, lowercase, NFC again (lowercasing
 * can decompose), every run of characters that are not a Unicode letter,
 * combining mark or digit becomes one `-`, leading and trailing dashes
 * removed, capped at {@link SCOPED_RULE_KEY_MAX_CHARS} code units (never
 * half of a surrogate pair), `null` when nothing is left. No language is
 * enumerated, so a name with no Latin character still keys, and a word
 * written with vowel signs or diacritic marks keys whole.
 */
export function scopedRuleKey(value: string): string | null {
  const folded = value.normalize("NFC").toLowerCase().normalize("NFC").replace(NON_KEY_RUN, "-");
  const trimmed = stripDashes(capCodeUnits(stripDashes(folded), SCOPED_RULE_KEY_MAX_CHARS));
  return trimmed === "" ? null : trimmed;
}

/** Slice to `max` code units without leaving half of a surrogate pair. */
function capCodeUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function stripDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}
