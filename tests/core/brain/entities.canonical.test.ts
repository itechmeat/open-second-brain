import { describe, expect, test } from "bun:test";

import {
  ENTITY_LABEL_MAX_LENGTH,
  InvalidEntityLabelError,
  assertValidEntityLabel,
  entityIdentityKey,
  entityMatchForms,
  isValidEntityLabel,
  normalizeEntityName,
  sanitizeEntityLabel,
  validateEntityCategory,
  validateEntityLabel,
} from "../../../src/core/brain/entities/canonical.ts";
import type {
  EntityLabelValidation,
  EntityLexiconHandle,
} from "../../../src/core/brain/entities/canonical.ts";

describe("normalizeEntityName", () => {
  test("lowercases and trims", () => {
    expect(normalizeEntityName("  Open Second Brain ")).toBe("open second brain");
  });

  test("collapses internal whitespace runs", () => {
    expect(normalizeEntityName("Open\t Second  Brain")).toBe("open second brain");
  });

  test("applies NFC so composed and decomposed forms agree", () => {
    const composed = "café"; // é as one code point
    const decomposed = "café"; // e + combining acute
    expect(normalizeEntityName(composed)).toBe(normalizeEntityName(decomposed));
  });

  test("keeps non-latin scripts intact", () => {
    expect(normalizeEntityName("Ада")).toBe("ада");
  });
});

describe("entityIdentityKey", () => {
  test("composes category and normalized name", () => {
    expect(entityIdentityKey("people", "  Ada ")).toBe("people:ada");
  });

  test("same key for case and whitespace variants", () => {
    expect(entityIdentityKey("projects", "Open  Second Brain")).toBe(
      entityIdentityKey("projects", "open second brain"),
    );
  });

  test("different categories never collide", () => {
    expect(entityIdentityKey("people", "mercury")).not.toBe(
      entityIdentityKey("systems", "mercury"),
    );
  });
});

describe("validateEntityCategory", () => {
  test("accepts kebab-case slugs", () => {
    expect(validateEntityCategory("people")).toBe("people");
    expect(validateEntityCategory("payment-systems")).toBe("payment-systems");
  });

  test("lowercases on the way through", () => {
    expect(validateEntityCategory("People")).toBe("people");
  });

  test("rejects path separators and traversal", () => {
    expect(() => validateEntityCategory("a/b")).toThrow();
    expect(() => validateEntityCategory("..")).toThrow();
  });

  test("rejects empty and whitespace-only", () => {
    expect(() => validateEntityCategory("  ")).toThrow();
  });

  test("rejects spaces inside the category", () => {
    expect(() => validateEntityCategory("payment systems")).toThrow();
  });
});

describe("sanitizeEntityLabel", () => {
  test("leaves clean labels byte-identical to a trim (backward compatible)", () => {
    const clean = ["Ada", "Open Second Brain", "café", "Ада", "北京", "Node.js", "C++", "e.g"];
    for (const label of clean) {
      expect(sanitizeEntityLabel(label)).toBe(label);
      // The intake pass must not shift the identity key of a clean label.
      expect(entityIdentityKey("people", sanitizeEntityLabel(label))).toBe(
        entityIdentityKey("people", label),
      );
    }
  });

  test("trims surrounding whitespace like the previous intake did", () => {
    expect(sanitizeEntityLabel("  Ada  ")).toBe("Ada");
  });

  test("strips Markdown emphasis wrappers", () => {
    expect(sanitizeEntityLabel("**Foo**")).toBe("Foo");
    expect(sanitizeEntityLabel("__Foo__")).toBe("Foo");
    expect(sanitizeEntityLabel("*Foo*")).toBe("Foo");
    expect(sanitizeEntityLabel("_Foo_")).toBe("Foo");
    expect(sanitizeEntityLabel("`Foo`")).toBe("Foo");
    expect(sanitizeEntityLabel("***Foo***")).toBe("Foo");
  });

  test("strips a leading Markdown heading marker", () => {
    expect(sanitizeEntityLabel("# Heading")).toBe("Heading");
    expect(sanitizeEntityLabel("###   Deep Heading")).toBe("Deep Heading");
  });

  test("strips surrounding but not internal punctuation", () => {
    expect(sanitizeEntityLabel("Foo.")).toBe("Foo");
    expect(sanitizeEntityLabel("Foo:")).toBe("Foo");
    expect(sanitizeEntityLabel("(baz)")).toBe("baz");
    expect(sanitizeEntityLabel('"quoted"')).toBe("quoted");
    expect(sanitizeEntityLabel("-Foo-")).toBe("Foo");
    // Internal punctuation is preserved.
    expect(sanitizeEntityLabel("Node.js")).toBe("Node.js");
    expect(sanitizeEntityLabel("New York, NY")).toBe("New York, NY");
  });

  test("strips CJK brackets (language-agnostic punctuation classes)", () => {
    expect(sanitizeEntityLabel("「名前」")).toBe("名前");
  });

  test("iterates nested decoration until stable", () => {
    expect(sanitizeEntityLabel("**(Foo)**")).toBe("Foo");
    expect(sanitizeEntityLabel("# **Heading.**")).toBe("Heading");
  });

  test("collapses pure-punctuation input to empty", () => {
    expect(sanitizeEntityLabel("***")).toBe("");
    expect(sanitizeEntityLabel("!!!")).toBe("");
    expect(sanitizeEntityLabel("( )")).toBe("");
  });
});

describe("validateEntityLabel", () => {
  test("accepts letter/digit labels in any script", () => {
    for (const label of ["Ada", "café", "Ада", "北京", "R2D2", "42"]) {
      expect(validateEntityLabel(label)).toEqual({ valid: true });
    }
  });

  test("rejects empty after strip", () => {
    expect(validateEntityLabel("")).toEqual({ valid: false, reason: "empty" });
  });

  test("rejects labels with no letter or digit in any script", () => {
    // A sanitized label can still be pure symbol (e.g. currency/math signs
    // that are \p{S}, not \p{P}, so they survive stripping).
    expect(validateEntityLabel("$$$")).toEqual({ valid: false, reason: "no-letter-or-digit" });
  });

  test("rejects labels over the length bound", () => {
    const long = "a".repeat(ENTITY_LABEL_MAX_LENGTH + 1);
    expect(validateEntityLabel(long)).toEqual({ valid: false, reason: "too-long" });
    expect(validateEntityLabel("a".repeat(ENTITY_LABEL_MAX_LENGTH))).toEqual({ valid: true });
  });

  test("rejects a denylisted label compared post-normalization", () => {
    const denylist = new Set([normalizeEntityName("Blocked Name")]);
    expect(validateEntityLabel("blocked name", { denylist })).toEqual({
      valid: false,
      reason: "denylisted",
    });
    expect(validateEntityLabel("Allowed", { denylist })).toEqual({ valid: true });
  });

  test("isValidEntityLabel mirrors the validation verdict", () => {
    expect(isValidEntityLabel("Ada")).toBe(true);
    expect(isValidEntityLabel("!!!")).toBe(false);
  });
});

describe("assertValidEntityLabel", () => {
  test("returns the sanitized label on success", () => {
    expect(assertValidEntityLabel("**Foo**")).toBe("Foo");
    expect(assertValidEntityLabel("Ada")).toBe("Ada");
  });

  test("throws a typed InvalidEntityLabelError carrying the reason", () => {
    try {
      assertValidEntityLabel("***");
      throw new Error("expected assertValidEntityLabel to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEntityLabelError);
      expect((err as InvalidEntityLabelError).reason).toBe("empty");
    }
  });

  test("throws on a denylisted label", () => {
    const denylist = new Set([normalizeEntityName("nope")]);
    expect(() => assertValidEntityLabel("Nope", { denylist })).toThrow(InvalidEntityLabelError);
  });
});

describe("entityMatchForms", () => {
  test("sanitizes and normalizes valid forms, dropping junk", () => {
    expect(entityMatchForms(["**Google**", "Ада", "***", "Foo."])).toEqual([
      "google",
      "ада",
      "foo",
    ]);
  });

  test("clean forms normalize exactly as before (backward compatible)", () => {
    expect(entityMatchForms(["Open Second Brain"])).toEqual(["open second brain"]);
  });
});

// ----- Lexicon verdict growth (recall-quality wave, S1) ----------------------
//
// The predicate grows two case-based refusal reasons behind an optional
// EntityLexiconHandle. With the handle null or absent the verdicts are
// byte-identical to v1.79.0 - pinned by the describe block at the bottom.

/**
 * A deterministic stand-in for the store-learned handle the lexicon
 * module resolves: EXACT lowercase-set lookup, so every test here also
 * pins that the predicate hands the handle lowercased tokens rather
 * than making the handle do the case folding.
 */
function lexiconOf(common: ReadonlySet<string>, caseful = true): EntityLexiconHandle {
  return { caseful, isCommonWord: (token) => common.has(token) };
}
const COMMON = new Set(["the", "and", "of", "meeting", "notes"]);

describe("validateEntityLabel - lexicon verdict growth", () => {
  test("an all-uppercase label refuses with shouted-heading behind a lexicon", () => {
    expect(validateEntityLabel("MEETING NOTES", { lexicon: lexiconOf(COMMON) })).toEqual({
      valid: false,
      reason: "shouted-heading",
    });
    expect(validateEntityLabel("TODO", { lexicon: lexiconOf(COMMON) })).toEqual({
      valid: false,
      reason: "shouted-heading",
    });
  });

  test("a run of store-learned common words refuses with function-word-run", () => {
    expect(validateEntityLabel("The And", { lexicon: lexiconOf(COMMON) })).toEqual({
      valid: false,
      reason: "function-word-run",
    });
    // A single common token is already a run; refusing it at creation is
    // the create-arm policy the registry wires on top of this verdict.
    expect(validateEntityLabel("The", { lexicon: lexiconOf(COMMON) })).toEqual({
      valid: false,
      reason: "function-word-run",
    });
  });

  test("shouted-heading wins when a label is both all-caps and all common words", () => {
    expect(validateEntityLabel("THE AND", { lexicon: lexiconOf(COMMON) })).toEqual({
      valid: false,
      reason: "shouted-heading",
    });
  });

  test("a caseful label whose word forms are not all common admits", () => {
    expect(validateEntityLabel("Ada", { lexicon: lexiconOf(COMMON) })).toEqual({ valid: true });
    expect(validateEntityLabel("Open Second Brain", { lexicon: lexiconOf(COMMON) })).toEqual({
      valid: true,
    });
  });

  test("a structural code shape bypasses both case verdicts", () => {
    for (const label of ["foo_bar", "FTS5", "Node.js", "path/to/x", "MEETING_NOTES", "OpenAI"]) {
      expect(validateEntityLabel(label, { lexicon: lexiconOf(COMMON) })).toEqual({ valid: true });
    }
  });

  test("word-initial uppercase is Title Case, not a code shape; mid-word uppercase is", () => {
    // Every uppercase sits at a word start, so the label is eligible for
    // the case verdicts - and every token is a learned common word.
    expect(validateEntityLabel("The And Of", { lexicon: lexiconOf(COMMON) })).toEqual({
      valid: false,
      reason: "function-word-run",
    });
    // The uppercase run crosses a word boundary: identifier-shaped, bypassed.
    expect(validateEntityLabel("TheAndOf", { lexicon: lexiconOf(COMMON) })).toEqual({
      valid: true,
    });
  });

  test("the code-shape bypass keeps the four structural verdicts", () => {
    const lx = lexiconOf(COMMON);
    expect(validateEntityLabel("", { lexicon: lx })).toEqual({ valid: false, reason: "empty" });
    expect(validateEntityLabel("___", { lexicon: lx })).toEqual({
      valid: false,
      reason: "no-letter-or-digit",
    });
    // too-long precedes the case verdicts even for an all-caps label.
    expect(validateEntityLabel("A".repeat(ENTITY_LABEL_MAX_LENGTH + 1), { lexicon: lx })).toEqual({
      valid: false,
      reason: "too-long",
    });
    expect(validateEntityLabel("a_".repeat(ENTITY_LABEL_MAX_LENGTH), { lexicon: lx })).toEqual({
      valid: false,
      reason: "too-long",
    });
    const denylist = new Set([normalizeEntityName("foo_bar")]);
    expect(validateEntityLabel("foo_bar", { lexicon: lx, denylist })).toEqual({
      valid: false,
      reason: "denylisted",
    });
  });

  test("caseless labels admit on the structural gate alone", () => {
    const lx = lexiconOf(COMMON);
    // Every token common, but no letter carries case: the case-based
    // verdicts do not run for caseless labels.
    expect(validateEntityLabel("the and of", { lexicon: lx })).toEqual({ valid: true });
    expect(validateEntityLabel("会議 notes", { lexicon: lx })).toEqual({ valid: true });
    expect(validateEntityLabel("ада", { lexicon: lx })).toEqual({ valid: true });
  });

  test("a caseless-script handle suppresses both case verdicts", () => {
    const lx = lexiconOf(COMMON, false);
    expect(validateEntityLabel("MEETING NOTES", { lexicon: lx })).toEqual({ valid: true });
    expect(validateEntityLabel("The And", { lexicon: lx })).toEqual({ valid: true });
  });

  test("tokens reach the handle lowercased", () => {
    const seen: string[] = [];
    const lx: EntityLexiconHandle = {
      caseful: true,
      isCommonWord: (token: string) => {
        seen.push(token);
        return true;
      },
    };
    expect(validateEntityLabel("The And", { lexicon: lx })).toEqual({
      valid: false,
      reason: "function-word-run",
    });
    expect(seen).toEqual(["the", "and"]);
  });

  test("the typed creation error carries the new reason", () => {
    try {
      assertValidEntityLabel("MEETING NOTES", { lexicon: lexiconOf(COMMON) });
      throw new Error("expected assertValidEntityLabel to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEntityLabelError);
      expect((err as InvalidEntityLabelError).reason).toBe("shouted-heading");
    }
  });

  test("entityMatchForms drops forms the grown verdicts refuse", () => {
    const opts = { lexicon: lexiconOf(COMMON) };
    expect(entityMatchForms(["MEETING NOTES", "The And", "Ada", "foo_bar"], opts)).toEqual([
      "ada",
      "foo_bar",
    ]);
  });
});

describe("validateEntityLabel - v1.79.0 byte identity with lexicon null or absent", () => {
  const DENYLIST = new Set([normalizeEntityName("Blocked Name")]);
  // One row per v1.79.0 verdict, plus caseful labels that the grown
  // verdicts WOULD refuse behind a lexicon - all must stay valid without one.
  const ROWS: ReadonlyArray<readonly [string, EntityLabelValidation]> = [
    ["Ada", { valid: true }],
    ["MEETING NOTES", { valid: true }],
    ["The And", { valid: true }],
    ["THE AND", { valid: true }],
    ["the and", { valid: true }],
    ["Node.js", { valid: true }],
    ["", { valid: false, reason: "empty" }],
    ["a".repeat(ENTITY_LABEL_MAX_LENGTH + 1), { valid: false, reason: "too-long" }],
    ["$$$", { valid: false, reason: "no-letter-or-digit" }],
  ];

  test("every v1.79.0 verdict is unchanged with no options", () => {
    for (const [label, expected] of ROWS) {
      expect(validateEntityLabel(label)).toEqual(expected);
    }
  });

  test("every v1.79.0 verdict is unchanged with an empty options object", () => {
    for (const [label, expected] of ROWS) {
      expect(validateEntityLabel(label, {})).toEqual(expected);
    }
  });

  test("every v1.79.0 verdict is unchanged with lexicon: null", () => {
    for (const [label, expected] of ROWS) {
      expect(validateEntityLabel(label, { lexicon: null })).toEqual(expected);
    }
  });

  test("the denylisted verdict is unchanged with lexicon: null beside the denylist", () => {
    expect(validateEntityLabel("blocked name", { denylist: DENYLIST, lexicon: null })).toEqual({
      valid: false,
      reason: "denylisted",
    });
    expect(validateEntityLabel("Allowed", { denylist: DENYLIST, lexicon: null })).toEqual({
      valid: true,
    });
  });
});
