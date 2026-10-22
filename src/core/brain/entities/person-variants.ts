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
 * Every emitted form meets a minimum-form-length floor (the same
 * discipline as the anchoring kernels' floor), the output order is
 * fixed (initial, reversed, then nicknames sorted), and the returned
 * array is frozen: same input, same bytes, on every peer. Derivation is
 * a re-ranking and resolution aid, never a retrieval mechanism and
 * never part of identity - `entityIdentityKey` is untouched by every
 * form this module emits.
 */

/**
 * Minimum normalized form length that a derived person variant must
 * reach to be emitted. Mirrors `MIN_ANCHOR_FORM_LENGTH` in
 * `canonical.ts` (3): a derived form is an emitted needle in its own
 * right, and an unfloored one would anchor standalone fragments no full
 * form ever matched. This module imports nothing, so the value is
 * restated here and pinned by tests rather than shared by import.
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
 * A name is split on single spaces (normalization collapsed any run).
 * Structural variants require at least two tokens AND no
 * unspaced-script character anywhere in the name; a variant equal to
 * the input name is never emitted, and every emitted form is at least
 * {@link MIN_PERSON_VARIANT_LENGTH} characters. Nickname expansion
 * consults ONLY `nicknames` - an absent or empty map yields no
 * nickname variants, and no hardcoded list exists anywhere in this
 * module. Pure: no I/O, no state.
 */
export function derivePersonNameVariants(
  name: string,
  nicknames: PersonNicknameMap = EMPTY_PERSON_NICKNAME_MAP,
): ReadonlyArray<string> {
  const out: string[] = [];
  const seen = new Set<string>();
  const consider = (form: string): void => {
    if (form.length < MIN_PERSON_VARIANT_LENGTH) return;
    if (form === name) return;
    if (seen.has(form)) return;
    seen.add(form);
    out.push(form);
  };

  const tokens = name.split(" ").filter((token) => token !== "");
  if (tokens.length > 0 && !NO_SPACE_SCRIPT_RE.test(name)) {
    if (tokens.length >= 2) {
      // First-initial-plus-surname: the initial of the first token,
      // then the remaining tokens verbatim ("ada mary lovelace" ->
      // "a mary lovelace").
      consider(`${tokens[0]!.slice(0, 1)} ${tokens.slice(1).join(" ")}`);
      // Reversed word order: "Last, First" read back as words.
      consider(tokens.slice().reverse().join(" "));
    }
  }

  if (nicknames.size > 0) {
    const nickHits: string[] = [];
    for (const [nick, fullNames] of nicknames) {
      if (!fullNames.includes(name)) continue;
      if (nick.length < MIN_PERSON_VARIANT_LENGTH || nick === name || seen.has(nick)) continue;
      nickHits.push(nick);
    }
    // Sorted so the output is independent of the operator map's
    // insertion order.
    for (const nick of nickHits.toSorted()) consider(nick);
  }

  return Object.freeze(out);
}
