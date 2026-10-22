/**
 * Person-name variant derivation (write-honesty-egress-consent, F3).
 *
 * Pure kernel over an ALREADY-NORMALIZED person name - the same
 * normalization shape as `normalizeEntityName` in `canonical.ts`: NFC,
 * lowercase, collapsed whitespace. This module is a LEAF of the import
 * graph and imports nothing, so every consumer (query expansion, the
 * registry's derived lookup lane, the doctor's collision scan) derives
 * from the one implementation rather than from three copies of the
 * rules. The price of the leaf position is stated where it bites: the
 * floor constant and the no-space script set below MIRROR their
 * canonical.ts siblings (`MIN_ANCHOR_FORM_LENGTH`, `NO_SPACE_SCRIPT_RE`)
 * instead of importing them, and the mirror is pinned by tests on both
 * sides.
 *
 * Three structural rules, deliberately all conservative:
 *
 *   - FIRST-INITIAL-PLUS-SURNAME: `ada lovelace` also answers to
 *     `a lovelace`. The initial convention is a spaced-script
 *     convention, so this form is emitted only for a multi-token name
 *     that carries no unspaced-script character.
 *   - REVERSED WORD ORDER: `ada lovelace` also answers to
 *     `lovelace ada`, the "Last, First" spelling read back as words.
 *     Like the initial form it is emitted only for a multi-token name
 *     with no unspaced-script character - in Han, Hiragana, Katakana,
 *     Thai, Lao, Khmer or Myanmar text a name's tokens are not word
 *     separable, and an unspaced-script (CJK) name emits NO word-order
 *     variants at all.
 *   - NICKNAMES: never derived from any shipped vocabulary. There is no
 *     hardcoded English word list here or downstream - the only
 *     nickname source is the operator-supplied map passed as an
 *     argument (a vault config map), exactly like the label denylist's
 *     operator-data-only rule. A name derives a nickname when the map
 *     lists the name's FULL normalized form among the values the
 *     nickname stands for.
 *
 * The two punctuation shapes normalization deliberately keeps - the
 * dotted initial (`A. Lovelace`) and the comma spelling
 * (`Lovelace, Ada`) - fold through {@link personNameComparisonForm}
 * before any comparison: the kernel derives from the comparison form of
 * its input, and every consumer compares query forms through the same
 * fold, so both usual spellings meet the same derived forms the plain
 * spelling does.
 *
 * Structural forms meet a minimum-form-length floor (the same
 * discipline as the anchoring kernels' floor). Operator-declared
 * nicknames are EXEMPT from that floor: they are data the operator
 * chose, not forms this module invented, so a two-letter nickname the
 * operator wrote down resolves instead of being silently dropped. The
 * output order is fixed (the plain word order of a dotted or comma
 * form, then initial, reversed, then nicknames sorted), and
 * the returned array is frozen: same input, same bytes, on every peer.
 * Derivation is a re-ranking and resolution aid, never a retrieval
 * mechanism and never part of identity - `entityIdentityKey` is
 * untouched by every form this module emits.
 */

/**
 * Minimum normalized form length that a derived STRUCTURAL person
 * variant must reach to be emitted. Mirrors `MIN_ANCHOR_FORM_LENGTH` in
 * `canonical.ts` (3): a derived form is an emitted needle in its own
 * right, and an unfloored one would anchor standalone fragments no full
 * form ever matched. Operator-declared nicknames are exempt - they are
 * data the operator chose, and the doctor reports the unusable ones.
 * This module imports nothing, so the value is restated here and pinned
 * by tests rather than shared by import.
 */
export const MIN_PERSON_VARIANT_LENGTH = 3;

/**
 * The registry categories that hold PERSON entities - the person
 * members of `ENTITY_TYPE_FOLDERS` in `canonical.ts`. Mirrored here for
 * the same leaf reason as the floor above; every consumer gates
 * person-variant derivation on this predicate, so orgs, companies and
 * teams never derive variants.
 */
export const PERSON_ENTITY_CATEGORIES: ReadonlyArray<string> = Object.freeze(["people", "person"]);

const PERSON_CATEGORY_SET: ReadonlySet<string> = new Set(PERSON_ENTITY_CATEGORIES);

/** True when `category` is a person-category registry folder. */
export function isPersonCategory(category: string): boolean {
  return PERSON_CATEGORY_SET.has(category);
}

/**
 * Operator-supplied nickname data: keyed by a normalized NICKNAME,
 * whose values are the normalized FULL person names the nickname can
 * stand for. The only vocabulary source for nickname expansion; an
 * empty or absent map means no nickname variants exist.
 */
export type PersonNicknameMap = ReadonlyMap<string, ReadonlyArray<string>>;

/** The shared empty map, so callers without nickname data allocate once. */
export const EMPTY_PERSON_NICKNAME_MAP: PersonNicknameMap = Object.freeze(new Map());

/**
 * The nickname map INVERTED for derivation: keyed by a normalized FULL
 * name, answering with the sorted nicknames it stands for. Building one
 * index per nickname-file signature turns every derivation's scan of
 * the whole operator map into a single lookup; the kernel consumes this
 * shape, and the cache in `registry.ts` builds it once per signature.
 */
export interface PersonNicknameIndex {
  /** The sorted nicknames the normalized FULL name `fullName` answers to. */
  nicknamesOf(fullName: string): ReadonlyArray<string>;
}

const NO_NICKNAMES: ReadonlyArray<string> = Object.freeze([]);

/** The shared empty index, so callers without nickname data allocate once. */
export const EMPTY_PERSON_NICKNAME_INDEX: PersonNicknameIndex = {
  nicknamesOf: () => NO_NICKNAMES,
};

/**
 * Invert the operator nickname map once: nick-to-names becomes
 * name-to-nicks, values deduplicated and sorted so the derivation's
 * output stays independent of the operator map's insertion order. Pure.
 */
export function invertPersonNicknameMap(nicknames: PersonNicknameMap): PersonNicknameIndex {
  const byFullName = new Map<string, string[]>();
  for (const [nick, fullNames] of nicknames) {
    for (const fullName of fullNames) {
      const prior = byFullName.get(fullName);
      if (prior === undefined) byFullName.set(fullName, [nick]);
      else if (!prior.includes(nick)) prior.push(nick);
    }
  }
  const frozen = new Map<string, ReadonlyArray<string>>();
  for (const [fullName, nicks] of byFullName) {
    frozen.set(fullName, Object.freeze(nicks.toSorted()));
  }
  return { nicknamesOf: (fullName) => frozen.get(fullName) ?? NO_NICKNAMES };
}

/**
 * The DERIVED-COMPARISON form of an already-normalized person-name
 * form: a single-code-point token drops a trailing full stop
 * (`a. lovelace` -> `a lovelace`) and a token that carried a comma
 * moves behind the rest (`lovelace, ada` -> `ada lovelace`). These are
 * the two punctuation shapes `normalizeEntityName` deliberately keeps,
 * and the two spellings in which people actually write names; folding
 * them on BOTH sides of every derived comparison lets the usual
 * spellings meet the same forms the plain spelling does. Pure, and a
 * no-op on forms that carry neither shape.
 */
export function personNameComparisonForm(form: string): string {
  const rest: string[] = [];
  const carried: string[] = [];
  for (const token of form.split(" ")) {
    if (token === "") continue;
    if (token.endsWith(".")) {
      const head = token.slice(0, -1);
      // Exactly one CODE POINT before the stop - measured in code points,
      // so an astral initial folds too instead of leaking a lone surrogate.
      if (head !== "" && Array.from(head).length === 1) {
        rest.push(head);
        continue;
      }
    }
    if (token.endsWith(",")) {
      const head = token.slice(0, -1);
      if (head !== "") carried.push(head);
      continue;
    }
    rest.push(token);
  }
  return [...rest, ...carried].join(" ");
}

/**
 * The forms a normalized QUERY spelling is compared through in the
 * derived lane: itself plus its comparison form, deduplicated. Pure.
 */
export function personVariantQueryForms(normalizedQuery: string): ReadonlyArray<string> {
  const comparison = personNameComparisonForm(normalizedQuery);
  if (comparison === "" || comparison === normalizedQuery) {
    return Object.freeze([normalizedQuery]);
  }
  return Object.freeze([normalizedQuery, comparison]);
}

/**
 * The scripts written WITHOUT word spaces - Han, Hiragana, Katakana,
 * Thai, Lao, Khmer, Myanmar. Mirrors `NO_SPACE_SCRIPT_RE` in
 * `canonical.ts` (which this leaf cannot import): Korean is
 * deliberately absent, because Hangul writes spaces between words.
 * A name containing any character from these scripts emits no
 * structural (initial or word-order) variants.
 */
const NO_SPACE_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Derive the person-name variants of the ALREADY-NORMALIZED name
 * `name`: first-initial-plus-surname, reversed word order, and the
 * operator-supplied nicknames the name answers to - in that fixed
 * order, nicknames sorted. Deterministic and frozen: the same input
 * yields byte-identical output on every call and every peer.
 *
 * Structural variants derive from the comparison form of `name` (see
 * {@link personNameComparisonForm}), so the dotted-initial and
 * comma-spelled forms derive the same variants their plain spelling
 * does. The initial is taken by CODE POINT, so an astral-script first
 * letter reaches the emitted form whole.
 *
 * A name is split on single spaces (normalization collapsed any run).
 * Structural variants require at least two tokens AND no
 * unspaced-script character anywhere in the name; a variant equal to
 * the input name or its comparison form is never emitted, and every
 * emitted STRUCTURAL form is at least {@link MIN_PERSON_VARIANT_LENGTH}
 * characters. Operator nicknames are exempt from that floor - they are
 * declared data, not forms this module invented. Nickname expansion
 * consults ONLY `nicknames` - an absent or empty index yields no
 * nickname variants, and no hardcoded list exists anywhere in this
 * module. Pure: no I/O, no state.
 */
export function derivePersonNameVariants(
  name: string,
  nicknames: PersonNicknameIndex = EMPTY_PERSON_NICKNAME_INDEX,
): ReadonlyArray<string> {
  const out: string[] = [];
  const seen = new Set<string>();
  const comparison = personNameComparisonForm(name);
  const consider = (form: string, floored: boolean): void => {
    if (floored && form.length < MIN_PERSON_VARIANT_LENGTH) return;
    if (form === name) return;
    if (seen.has(form)) return;
    seen.add(form);
    out.push(form);
  };

  const tokens = comparison.split(" ").filter((token) => token !== "");
  if (tokens.length > 0 && !NO_SPACE_SCRIPT_RE.test(comparison)) {
    if (tokens.length >= 2) {
      // The plain word-order spelling of a dotted or comma form
      // ("lovelace, ada" -> "ada lovelace"); a no-op for a form that
      // already carries neither shape.
      consider(comparison, true);
      // First-initial-plus-surname: the initial CODE POINT of the first
      // token, then the remaining tokens verbatim ("ada mary lovelace" ->
      // "a mary lovelace").
      const initial = Array.from(tokens[0]!)[0] ?? tokens[0]!;
      consider(`${initial} ${tokens.slice(1).join(" ")}`, true);
      // Reversed word order: "Last, First" read back as words.
      consider(tokens.slice().reverse().join(" "), true);
    }
  }

  for (const nick of nicknames.nicknamesOf(name)) {
    // Operator-declared nicknames bypass the structural floor; the skips
    // that remain are the ones that would resolve the person to a form
    // they already answer to.
    consider(nick, false);
  }

  return Object.freeze(out);
}
