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
