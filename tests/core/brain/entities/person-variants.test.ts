/**
 * Person-name variant derivation (write-honesty-egress-consent, F3 / C1).
 *
 * The module is a leaf: it imports nothing, so these tests exercise the
 * pure kernel only - determinism, the structural form-length floor, the
 * nickname floor exemption, script neutrality, the comparison forms for
 * the dotted-initial and comma spellings, and the rule that nickname
 * expansion comes exclusively from the operator-supplied argument.
 */

import { describe, expect, test } from "bun:test";

import {
  derivePersonNameVariants,
  invertPersonNicknameMap,
  isPersonCategory,
  MIN_PERSON_VARIANT_LENGTH,
  personNameComparisonForm,
  PERSON_ENTITY_CATEGORIES,
  personVariantQueryForms,
  type PersonNicknameMap,
} from "../../../../src/core/brain/entities/person-variants.ts";

function mapOf(entries: Record<string, string[]>): PersonNicknameMap {
  return Object.freeze(
    new Map(Object.entries(entries).map(([k, v]) => [k, Object.freeze([...v])])),
  );
}

/** The operator map, inverted the way every real consumer does. */
function indexOf(entries: Record<string, string[]>) {
  return invertPersonNicknameMap(mapOf(entries));
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

  test("nickname expansion comes only from the operator index argument", () => {
    // No map: no nickname data exists, so nothing beyond structural forms.
    const bare = derivePersonNameVariants("robert smith");
    expect([...bare]).toEqual(["r smith", "smith robert"]);
    expect([...bare]).not.toContain("bob");
    // With the operator data (inverted from the config reader's shape):
    // the nickname joins, sorted after the structural forms.
    const mapped = derivePersonNameVariants("robert smith", indexOf({ bob: ["robert smith"] }));
    expect([...mapped]).toEqual(["r smith", "smith robert", "bob"]);
  });

  test("nickname matching is exact over the full normalized name", () => {
    const index = indexOf({ bob: ["robert jones", "roberta stone"] });
    expect([...derivePersonNameVariants("robert smith", index)]).toEqual([
      "r smith",
      "smith robert",
    ]);
    expect([...derivePersonNameVariants("roberta stone", index)]).toEqual([
      "r stone",
      "stone roberta",
      "bob",
    ]);
  });

  test("multiple matching nicknames come out sorted", () => {
    const index = indexOf({
      roberto: ["robert smith"],
      bob: ["robert smith"],
      bobby: ["robert smith"],
    });
    const out = derivePersonNameVariants("robert smith", index);
    expect([...out]).toEqual(["r smith", "smith robert", "bob", "bobby", "roberto"]);
  });

  test(`structural forms shorter than MIN_PERSON_VARIANT_LENGTH (${MIN_PERSON_VARIANT_LENGTH}) are dropped`, () => {
    expect(MIN_PERSON_VARIANT_LENGTH).toBe(3);
    // A two-token name whose initial form would be below the floor
    // ("a b" is 3 - use a name whose initial form stays under it).
    expect([...derivePersonNameVariants("a bo")]).toEqual(["bo a"]);
  });

  test("operator-declared nicknames are exempt from the structural floor", () => {
    // The operator chose these forms; the kernel's floor is for forms
    // the kernel invented. A two-letter nickname resolves.
    const index = indexOf({ ed: ["ma li"], al: ["alan lovelace"] });
    expect([...derivePersonNameVariants("ma li", index)]).toEqual(["m li", "li ma", "ed"]);
    expect([...derivePersonNameVariants("alan lovelace", index)]).toEqual([
      "a lovelace",
      "lovelace alan",
      "al",
    ]);
  });

  test("the floor is measured on the whole emitted form, not per token", () => {
    // "a li" is 4 characters and clears the floor even though the
    // initial itself is one character.
    const out = derivePersonNameVariants("ada li");
    expect([...out]).toEqual(["a li", "li ada"]);
  });

  test("the initial is taken by code point, so an astral first letter stays whole", () => {
    // U+10414 DESERET CAPITAL LETTER AIL - a surrogate pair in UTF-16.
    const out = derivePersonNameVariants("\u{10414}avid smith");
    expect([...out]).toContain("\u{10414} smith");
    expect([...out].join("")).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
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
    const index = indexOf({ taro: ["田中 太郎"] });
    expect([...derivePersonNameVariants("田中 太郎", index)]).toEqual(["taro"]);
  });

  test("an empty or whitespace name derives nothing", () => {
    expect([...derivePersonNameVariants("")]).toEqual([]);
    expect([...derivePersonNameVariants("   ")]).toEqual([]);
  });

  test("the dotted-initial and comma spellings derive the same variants as the plain form", () => {
    // "A. Lovelace" normalizes to "a. lovelace": the comparison form
    // folds the dotted initial, so the record also answers to the plain
    // initial spelling, and the reversed form keeps the punctuation off.
    expect([...derivePersonNameVariants("a. lovelace")]).toEqual(["a lovelace", "lovelace a"]);
    // "Lovelace, Ada" normalizes to "lovelace, ada": the comma folds,
    // so the plain word order joins the plain spelling's variants.
    expect([...derivePersonNameVariants("lovelace, ada")]).toEqual([
      "ada lovelace",
      "a lovelace",
      "lovelace ada",
    ]);
  });

  test("a nickname declared for a comma-spelled full name still resolves", () => {
    // Operator data lists the full name exactly as the record spells it.
    const index = indexOf({ ada: ["lovelace, ada"] });
    expect([...derivePersonNameVariants("lovelace, ada", index)]).toEqual([
      "ada lovelace",
      "a lovelace",
      "lovelace ada",
      "ada",
    ]);
  });
});

describe("personNameComparisonForm", () => {
  test("a single-code-point token drops a trailing full stop", () => {
    expect(personNameComparisonForm("a. lovelace")).toBe("a lovelace");
    expect(personNameComparisonForm("ada m. lovelace")).toBe("ada m lovelace");
  });

  test("the dot fold is measured in code points, not UTF-16 units", () => {
    expect(personNameComparisonForm("\u{10414}. smith")).toBe("\u{10414} smith");
  });

  test("a comma-carrying token moves behind the rest", () => {
    expect(personNameComparisonForm("lovelace, ada")).toBe("ada lovelace");
    expect(personNameComparisonForm("lovelace, ada mary")).toBe("ada mary lovelace");
  });

  test("multi-token dotted forms and bare tokens are untouched", () => {
    // A dotted abbreviation that is not a single letter stays verbatim,
    // and a clean form is a no-op.
    expect(personNameComparisonForm("st. john smith")).toBe("st. john smith");
    expect(personNameComparisonForm("ada lovelace")).toBe("ada lovelace");
    expect(personNameComparisonForm("")).toBe("");
  });
});

describe("personVariantQueryForms", () => {
  test("a plain spelling compares through itself alone", () => {
    expect([...personVariantQueryForms("ada lovelace")]).toEqual(["ada lovelace"]);
  });

  test("the dotted and comma spellings compare through both forms", () => {
    expect([...personVariantQueryForms("a. lovelace")]).toEqual(["a. lovelace", "a lovelace"]);
    expect([...personVariantQueryForms("lovelace, ada")]).toEqual([
      "lovelace, ada",
      "ada lovelace",
    ]);
  });
});

describe("invertPersonNicknameMap", () => {
  test("the inverted index answers sorted nicknames per full name", () => {
    const index = invertPersonNicknameMap(mapOf({ zed: ["ada lovelace"], ace: ["ada lovelace"] }));
    expect([...index.nicknamesOf("ada lovelace")]).toEqual(["ace", "zed"]);
    expect(index.nicknamesOf("nobody here")).toEqual([]);
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
