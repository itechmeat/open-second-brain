/**
 * The pure blank-overwrite predicate (nothing-writes-silently, unit B).
 *
 * Claims pinned here:
 *
 *   1. A blank replacement over a body that carries text is REFUSED.
 *   2. `allowEmpty` is the one way through, so a deliberate clear stays
 *      possible and is never confused with an accidental one.
 *   3. "Blank" is `trim().length === 0`, so a whitespace-only body is
 *      blank - the parser trims, so those bytes are read back as an
 *      empty body and the note is emptied either way.
 *   4. A body that is ALREADY blank has nothing to lose, so replacing it
 *      with another blank body is not a refusal.
 *   5. The predicate is pure: same inputs, same answer, no I/O.
 */

import { describe, expect, test } from "bun:test";

import { refuseBlankOverwrite } from "../../../../src/core/brain/notes/blank-overwrite-guard.ts";

describe("refuseBlankOverwrite", () => {
  test("an empty replacement over a body with text is refused", () => {
    expect(refuseBlankOverwrite({ existingBody: "real content", nextBody: "" })).toBe(true);
  });

  test("a replacement that carries text is never refused", () => {
    expect(refuseBlankOverwrite({ existingBody: "real content", nextBody: "new" })).toBe(false);
  });

  test("allowEmpty lets a deliberate clear through", () => {
    expect(
      refuseBlankOverwrite({ existingBody: "real content", nextBody: "", allowEmpty: true }),
    ).toBe(false);
  });

  test("whitespace-only counts as blank on the replacement side", () => {
    // The last entry is U+00A0 NO-BREAK SPACE, which `trim` also removes.
    for (const nextBody of [" ", "\n", "\t\n  \n", " "]) {
      expect(refuseBlankOverwrite({ existingBody: "real content", nextBody })).toBe(true);
    }
  });

  test("a character that is not whitespace is content, however invisible", () => {
    // U+200B ZERO WIDTH SPACE is not ECMAScript whitespace, so `trim`
    // keeps it and the note keeps a body. The predicate does not invent
    // a wider notion of emptiness than the parser has.
    expect(refuseBlankOverwrite({ existingBody: "real content", nextBody: "​" })).toBe(false);
  });

  test("an already-blank body has nothing to lose", () => {
    expect(refuseBlankOverwrite({ existingBody: "", nextBody: "" })).toBe(false);
    expect(refuseBlankOverwrite({ existingBody: "   \n", nextBody: "" })).toBe(false);
  });

  test("the predicate is pure - repeated calls agree", () => {
    const input = { existingBody: "keep me", nextBody: "  " } as const;
    expect(refuseBlankOverwrite(input)).toBe(true);
    expect(refuseBlankOverwrite(input)).toBe(true);
  });
});
