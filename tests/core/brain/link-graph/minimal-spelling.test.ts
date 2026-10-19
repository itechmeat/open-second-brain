/**
 * The minimal-spelling chooser for inbound wikilink retargets.
 *
 * When a note moves, the links that named it should come out no longer
 * than they have to be: `[[Projects/Old]]` wants to become `[[New]]`,
 * not `[[Projects/New]]`, whenever the bare basename still resolves to
 * the moved note. What "still resolves" means is not this chooser's
 * opinion to invent - it is the store's read-time resolution ladder
 * (`store/links.ts`, RESOLVED_LINK_TARGET_SQL): an exact path match
 * (with the `.md` suffix appended or not), then an unambiguous
 * nested-basename match, with a TOP-LEVEL `New.md` owning the bare
 * `New` spelling outright no matter how many nested notes also carry
 * that basename.
 *
 * So the chooser asks, shortest form first: basename, suffix-less
 * relPath, full relPath. The first spelling the ladder resolves to
 * EXACTLY the destination wins. An ambiguous spelling is not a stop -
 * it falls through to the next-longer form, because a spelling that
 * resolves to two documents resolves, by the ladder's own rule, to
 * neither, and a spelling that resolves to a DIFFERENT document is
 * precisely the wrong one never to write.
 *
 * Deliberately NOT modeled here: alias resolution. The chooser judges a
 * file population (the paths a walk produced), and aliases live in the
 * index's `doc_aliases` table, not in any walked list. A spelling that
 * only an alias could resolve is not minimal by this measure, and the
 * chooser returning a longer form for it is the honest answer.
 */

import { describe, expect, test } from "bun:test";

import { minimalSpellingFor } from "../../../../src/core/brain/link-graph/minimal-spelling.ts";

describe("minimalSpellingFor", () => {
  test("the unique nested basename is the minimal spelling", () => {
    const files = ["Projects/New.md", "Projects/Ref.md", "Brain/_BRAIN.md"];
    expect(minimalSpellingFor("Projects/New.md", files)).toBe("New");
  });

  test("a top-level basename is the minimal spelling for a top-level note", () => {
    const files = ["New.md", "Projects/Other.md"];
    expect(minimalSpellingFor("New.md", files)).toBe("New");
  });

  test("a top-level note with the same basename beats the nested one (ladder rung 2)", () => {
    // Bare `New` resolves, by rung 2, to the TOP-LEVEL note - so for the
    // nested destination the bare spelling is a WRONG answer, not an
    // ambiguous one, and the chooser must never return it.
    const files = ["A/New.md", "New.md"];
    expect(minimalSpellingFor("A/New.md", files)).toBe("A/New");
  });

  test("an ambiguous nested basename falls through to the suffix-less relPath", () => {
    // Two nested carriers: the ladder's basename rung resolves to
    // neither, so the next-longer form is the first honest one.
    const files = ["A/New.md", "B/New.md", "Notes/Ref.md"];
    expect(minimalSpellingFor("A/New.md", files)).toBe("A/New");
  });

  test("a basename resolving to a DIFFERENT document is never chosen", () => {
    const files = ["A/New.md", "New.md", "Deep/New.md"];
    // Bare `New` -> the top-level note (rung 2). Suffix-less `A/New` is
    // the shortest spelling that resolves to the destination.
    expect(minimalSpellingFor("A/New.md", files)).toBe("A/New");
    expect(minimalSpellingFor("Deep/New.md", files)).toBe("Deep/New");
  });

  test("the full relPath is the fallback when nothing shorter resolves to the destination", () => {
    const files = ["A/New.md", "B/New.md", "C/New.md"];
    expect(minimalSpellingFor("A/New.md", files)).toBe("A/New");
  });

  test("a destination absent from the population yields the destination itself, never a guess", () => {
    const files = ["Notes/Ref.md"];
    expect(minimalSpellingFor("Projects/New.md", files)).toBe("Projects/New.md");
  });

  test("other notes sharing no basename never shorten the answer below the basename", () => {
    const files = ["Deep/Nested/New.md", "Deep/Nested/Old.md", "x.md"];
    expect(minimalSpellingFor("Deep/Nested/New.md", files)).toBe("New");
  });

  test("a basename carried only by the destination's own former self is judged on the post state", () => {
    // The caller derives the post-move population; the chooser only ever
    // sees files. With the old path gone and the new one present, the
    // basename of the NEW name is what decides.
    const files = ["Projects/New.md", "Projects/Ref.md"];
    expect(minimalSpellingFor("Projects/New.md", files)).toBe("New");
  });

  test("empty basename and multi-segment destinations stay well-formed", () => {
    expect(minimalSpellingFor("Solo.md", ["Solo.md"])).toBe("Solo");
    expect(minimalSpellingFor("a/b/c/Deep.md", ["a/b/c/Deep.md", "a/b/c/Other.md"])).toBe("Deep");
  });
});
