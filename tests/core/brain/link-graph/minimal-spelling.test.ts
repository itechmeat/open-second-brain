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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { minimalSpellingFor } from "../../../../src/core/brain/link-graph/minimal-spelling.ts";
import { indexVault } from "../../../../src/core/search/indexer.ts";
import { Store } from "../../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../../helpers/search-fixtures.ts";

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

  test("the suffix-less relPath is the fallback when the basename is ambiguous", () => {
    const files = ["A/New.md", "B/New.md", "C/New.md"];
    expect(minimalSpellingFor("A/New.md", files)).toBe("A/New");
  });

  test("a case-insensitive .md spelling still tries the append rung (ladder rung 2)", () => {
    // "x.Md" ends in ".md" case-insensitively, but the ladder's append
    // rung is unconditional: a spelling resolves when a document equals it
    // OR it + ".md". The top-level "x.Md.md" therefore OWNS the "x.Md"
    // spelling (rung 2 answers it before the basename rung is reached),
    // and the nested destination must never come out as "x.Md" - the
    // ladder would resolve that link to the OTHER note.
    const files = ["x.Md.md", "B/x.Md.md"];
    expect(minimalSpellingFor("B/x.Md.md", files)).not.toBe("x.Md");
    expect(minimalSpellingFor("B/x.Md.md", files)).toBe("B/x.Md");
  });

  test("the basename rung still answers when the append form is absent", () => {
    // With no top-level "x.Md.md" in the population the append rung has
    // nothing to answer, so the unique nested carrier of the stored
    // basename "x.Md" owns the spelling - the ladder's rung 3. Trying
    // the append rung must not SUPPRESS the basename rung.
    const files = ["B/x.Md.md", "Notes/Ref.md"];
    expect(minimalSpellingFor("B/x.Md.md", files)).toBe("x.Md");
  });

  test("the exact-path rung beats the append rung when both documents exist", () => {
    // The ladder's COALESCE answers the exact path before the appended
    // one, so "x.Md" resolves to the document literally named "x.Md" -
    // which is not the destination, and the spelling falls through.
    const files = ["x.Md", "x.Md.md", "B/x.Md.md"];
    expect(minimalSpellingFor("B/x.Md.md", files)).toBe("B/x.Md");
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

  test("an uppercase .MD stem is not stripped: the bare lowercase form is never the answer", () => {
    // The store's `documentBasename` strips a trailing `.md` CASE-
    // SENSITIVELY, so `Projects/Old.MD` keeps the stored basename
    // `Old.MD` and the bare spelling `Old` dangles. The chooser's
    // basename rung must strip under the same rule, or it would hand
    // back exactly the spelling the ladder cannot resolve.
    const files = ["Projects/Old.MD", "Projects/Ref.md"];
    expect(minimalSpellingFor("Projects/Old.MD", files)).not.toBe("Old");
    expect(minimalSpellingFor("Projects/Old.MD", files)).toBe("Old.MD");
  });

  test("empty basename and multi-segment destinations stay well-formed", () => {
    expect(minimalSpellingFor("Solo.md", ["Solo.md"])).toBe("Solo");
    expect(minimalSpellingFor("a/b/c/Deep.md", ["a/b/c/Deep.md", "a/b/c/Other.md"])).toBe("Deep");
  });
});

/**
 * Chooser and ladder agreement, pinned against a real index.
 *
 * The chooser re-derives the store's resolution rules in pure form, and
 * a re-derivation drifts unless something compares the two on the same
 * vault. Each fixture below builds a temp vault whose shape is one of
 * the chooser's unit populations, asks the chooser for the minimal
 * spelling of a destination, writes a referencing note that uses the
 * chosen spelling (and, where the shape has one, a second note using
 * the bare basename), indexes the vault, and then asks the store's OWN
 * ladder - `resolvedDocLinkPairs`, the same RESOLVED_LINK_TARGET_SQL
 * the census and the dangling list follow - which document that link
 * resolves to. Agreement means: the chosen spelling lands on the
 * destination document, every time, on every population shape.
 */
describe("agreement with the store resolution ladder", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const created = createTempVault("minimal-spelling-ladder");
    vault = created.vault;
    dbPath = created.dbPath;
    cleanup = created.cleanup;
  });
  afterEach(() => cleanup());

  /** Index `vault` and return the resolved target path of every link. */
  async function resolvedLinkTargets(): Promise<Array<{ source: string; target: string }>> {
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { force: true });
    const store = await Store.open(config, { mode: "read" });
    try {
      const idToPath = new Map<number, string>();
      for (const [path, summary] of store.listDocuments()) idToPath.set(summary.id, path);
      return store.resolvedDocLinkPairs().flatMap((pair) => {
        const source = idToPath.get(pair.source);
        const target = idToPath.get(pair.target);
        return source !== undefined && target !== undefined ? [{ source, target }] : [];
      });
    } finally {
      await store.close();
    }
  }

  /**
   * Write the population, ask the chooser for the minimal spelling of
   * `destination`, write a ref note citing that spelling, and return the
   * chosen spelling so the assertions can name what they pinned.
   */
  function refCitingChooserSpelling(
    population: ReadonlyArray<string>,
    destination: string,
  ): string {
    const spelling = minimalSpellingFor(
      destination,
      population.filter((rel) => rel !== "Notes/Ref.md"),
    );
    writeMd(vault, "Notes/Ref.md", `see [[${spelling}]] here\n`);
    for (const rel of population) if (rel !== "Notes/Ref.md") writeMd(vault, rel, "body\n");
    return spelling;
  }

  test("a unique nested basename resolves through the ladder to the destination", async () => {
    const destination = "Projects/New.md";
    const spelling = refCitingChooserSpelling(
      ["Projects/New.md", "Projects/Ref.md", "Notes/Ref.md"],
      destination,
    );
    expect(spelling).toBe("New");
    const pairs = await resolvedLinkTargets();
    expect(pairs).toContainEqual({ source: "Notes/Ref.md", target: destination });
  });

  test("a top-level destination's bare spelling resolves through the exact rung", async () => {
    const destination = "New.md";
    const spelling = refCitingChooserSpelling(
      ["New.md", "Projects/Other.md", "Notes/Ref.md"],
      destination,
    );
    expect(spelling).toBe("New");
    const pairs = await resolvedLinkTargets();
    expect(pairs).toContainEqual({ source: "Notes/Ref.md", target: destination });
  });

  test("under a top-level basename carrier the suffix-less spelling resolves to the nested destination", async () => {
    const destination = "A/New.md";
    const spelling = refCitingChooserSpelling(["A/New.md", "New.md", "Notes/Ref.md"], destination);
    expect(spelling).toBe("A/New");
    const pairs = await resolvedLinkTargets();
    expect(pairs).toContainEqual({ source: "Notes/Ref.md", target: destination });
  });

  test("with two nested carriers the suffix-less spelling resolves and the bare one resolves to neither", async () => {
    const destination = "A/New.md";
    const spelling = refCitingChooserSpelling(
      ["A/New.md", "B/New.md", "Notes/Ref.md"],
      destination,
    );
    expect(spelling).toBe("A/New");
    writeMd(vault, "Bare/Ref.md", "bare [[New]] here\n");
    const pairs = await resolvedLinkTargets();
    // The chooser's spelling lands on the destination...
    expect(pairs).toContainEqual({ source: "Notes/Ref.md", target: destination });
    // ...and the bare spelling the chooser refused is unresolved, which
    // is exactly why it was refused.
    expect(pairs.find((pair) => pair.source === "Bare/Ref.md")).toBeUndefined();
  });
});
