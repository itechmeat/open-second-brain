/**
 * Person-name variant derivation (write-honesty-egress-consent, F3 / C1).
 *
 * The module is a leaf: it imports nothing, so these tests exercise the
 * pure kernel only - determinism, the form-length floor, script
 * neutrality, and the rule that nickname expansion comes exclusively
 * from the operator-supplied map argument.
 */

import { describe, expect, test } from "bun:test";

import {
  derivePersonNameVariants,
  isPersonCategory,
  MIN_PERSON_VARIANT_LENGTH,
  PERSON_ENTITY_CATEGORIES,
  type PersonNicknameMap,
} from "../../../../src/core/brain/entities/person-variants.ts";

function mapOf(entries: Record<string, string[]>): PersonNicknameMap {
  return Object.freeze(
    new Map(Object.entries(entries).map(([k, v]) => [k, Object.freeze([...v])])),
  );
}

describe("derivePersonNameVariants", () => {
  test("same input yields byte-identical frozen output", () => {
    const a = derivePersonNameVariants("ada lovelace");
    const b = derivePersonNameVariants("ada lovelace");
    expect(Object.isFrozen(a)).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect([...a]).toEqual([...b]);
  });

  test("two-token name derives first-initial-plus-surname and reversed order, in that order", () => {
    const out = derivePersonNameVariants("ada lovelace");
    expect([...out]).toEqual(["a lovelace", "lovelace ada"]);
  });

  test("three-token name keeps the middle tokens in both structural variants", () => {
    const out = derivePersonNameVariants("ada mary lovelace");
    expect([...out]).toEqual(["a mary lovelace", "lovelace mary ada"]);
  });

  test("a variant equal to the input name is never emitted", () => {
    const out = derivePersonNameVariants("ma li");
    expect([...out]).not.toContain("ma li");
    // A two-token name whose reversal equals itself stays single-form.
    const same = derivePersonNameVariants("li li");
    expect([...same]).toEqual(["l li"]);
  });

  test("a single-token name derives no structural variants", () => {
    expect([...derivePersonNameVariants("cher")]).toEqual([]);
    expect([...derivePersonNameVariants("smith")]).toEqual([]);
  });

  test("nickname expansion comes only from the operator map argument", () => {
    // No map: no nickname data exists, so nothing beyond structural forms.
    const bare = derivePersonNameVariants("robert smith");
    expect([...bare]).toEqual(["r smith", "smith robert"]);
    expect([...bare]).not.toContain("bob");
    // With the operator map (normalized keys and values, the shape the
    // config reader hands over): the nickname joins, sorted after the
    // structural forms.
    const mapped = derivePersonNameVariants("robert smith", mapOf({ bob: ["robert smith"] }));
    expect([...mapped]).toEqual(["r smith", "smith robert", "bob"]);
  });

  test("nickname matching is exact over the full normalized name", () => {
    const map = mapOf({ bob: ["robert jones", "roberta stone"] });
    expect([...derivePersonNameVariants("robert smith", map)]).toEqual(["r smith", "smith robert"]);
    expect([...derivePersonNameVariants("roberta stone", map)]).toEqual([
      "r stone",
      "stone roberta",
      "bob",
    ]);
  });

  test("multiple matching nicknames come out sorted", () => {
    const map = mapOf({
      roberto: ["robert smith"],
      bob: ["robert smith"],
      bobby: ["robert smith"],
    });
    const out = derivePersonNameVariants("robert smith", map);
    expect([...out]).toEqual(["r smith", "smith robert", "bob", "bobby", "roberto"]);
  });

  test(`forms shorter than MIN_PERSON_VARIANT_LENGTH (${MIN_PERSON_VARIANT_LENGTH}) are dropped`, () => {
    expect(MIN_PERSON_VARIANT_LENGTH).toBe(3);
    // A two-letter nickname is below the floor and never emitted.
    const map = mapOf({ ed: ["ma li"] });
    expect([...derivePersonNameVariants("ma li", map)]).toEqual(["m li", "li ma"]);
  });

  test("the floor is measured on the whole emitted form, not per token", () => {
    // "a li" is 4 characters and clears the floor even though the
    // initial itself is one character.
    const out = derivePersonNameVariants("ada li");
    expect([...out]).toEqual(["a li", "li ada"]);
  });

  test("unspaced-script names emit no word-order or initial variants", () => {
    expect([...derivePersonNameVariants("田中太郎")]).toEqual([]);
    // Even when the operator spells the family and given names with a
    // space, a CJK name gets no structural variants: the reversed and
    // initial forms are spaced-script conventions.
    expect([...derivePersonNameVariants("田中 太郎")]).toEqual([]);
    // A mixed-script name carries an unspaced-script token, so its
    // structural variants stay silent too.
    expect([...derivePersonNameVariants("ada 田中")]).toEqual([]);
  });

  test("operator nicknames still apply to unspaced-script names", () => {
    const map = mapOf({ taro: ["田中 太郎"] });
    expect([...derivePersonNameVariants("田中 太郎", map)]).toEqual(["taro"]);
  });

  test("an empty or whitespace name derives nothing", () => {
    expect([...derivePersonNameVariants("")]).toEqual([]);
    expect([...derivePersonNameVariants("   ")]).toEqual([]);
  });
});

describe("isPersonCategory", () => {
  test("admits exactly the person-category folders", () => {
    expect(PERSON_ENTITY_CATEGORIES).toEqual(["people", "person"]);
    expect(isPersonCategory("people")).toBe(true);
    expect(isPersonCategory("person")).toBe(true);
  });

  test("rejects every non-person category", () => {
    expect(isPersonCategory("projects")).toBe(false);
    expect(isPersonCategory("org")).toBe(false);
    expect(isPersonCategory("organization")).toBe(false);
    expect(isPersonCategory("organisation")).toBe(false);
    expect(isPersonCategory("company")).toBe(false);
    expect(isPersonCategory("team")).toBe(false);
    expect(isPersonCategory("")).toBe(false);
  });
});
