import { describe, expect, test } from "bun:test";

import {
  entityIdentityKey,
  normalizeEntityName,
  validateEntityCategory,
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
    expect(normalizeEntityName("Сергей")).toBe("сергей");
  });
});

describe("entityIdentityKey", () => {
  test("composes category and normalized name", () => {
    expect(entityIdentityKey("people", "  Sergey ")).toBe("people:sergey");
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
