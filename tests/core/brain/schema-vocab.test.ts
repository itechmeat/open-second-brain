import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SCHEMA_VOCAB,
  SchemaVocabularyError,
  isKnownSchemaToken,
  normalizeSchemaToken,
  resolveSchemaVocabulary,
  validateSchemaDeclarations,
} from "../../../src/core/brain/schema-vocab.ts";

describe("Brain schema vocabulary", () => {
  test("default vocabulary is frozen and exposes the built-in taxonomy", () => {
    expect(Object.isFrozen(DEFAULT_SCHEMA_VOCAB)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCHEMA_VOCAB.preference_types)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCHEMA_VOCAB.signal_types)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCHEMA_VOCAB.page_types)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCHEMA_VOCAB.log_event_kinds)).toBe(true);

    expect(DEFAULT_SCHEMA_VOCAB.preference_types).toContain("preference");
    expect(DEFAULT_SCHEMA_VOCAB.signal_types).toContain("feedback");
    expect(DEFAULT_SCHEMA_VOCAB.page_types).toContain("note");
    expect(DEFAULT_SCHEMA_VOCAB.log_event_kinds).toEqual(
      expect.arrayContaining(["dream", "feedback", "note", "import-session"]),
    );
  });

  test("normalizeSchemaToken is NFC, trimmed, and lowercase", () => {
    expect(normalizeSchemaToken("  Research-Note  ")).toBe("research-note");
    expect(normalizeSchemaToken("THERAPY_SESSION")).toBe("therapy_session");
    expect(normalizeSchemaToken("Cafe\u0301")).toBe("café");
  });

  test("resolveSchemaVocabulary merges declarations after built-ins and de-duplicates", () => {
    const vocab = resolveSchemaVocabulary({
      preference_types: ["research", "Research", "decision"],
      signal_types: ["observation", "feedback"],
      page_types: ["paper", "researcher"],
      log_event_kinds: ["milestone", "note"],
    });

    expect(vocab.preference_types).toEqual([
      "preference",
      "research",
      "decision",
    ]);
    expect(vocab.signal_types).toEqual(["feedback", "observation"]);
    expect(vocab.page_types).toEqual(["note", "paper", "researcher"]);
    expect(vocab.log_event_kinds).toEqual(
      expect.arrayContaining([
        "dream",
        "feedback",
        "note",
        "import-session",
        "milestone",
      ]),
    );
    expect(
      vocab.log_event_kinds.filter((kind) => kind === "note"),
    ).toHaveLength(1);
    expect(Object.isFrozen(vocab)).toBe(true);
    expect(Object.isFrozen(vocab.preference_types)).toBe(true);
  });

  test("isKnownSchemaToken checks a resolved vocabulary category", () => {
    const vocab = resolveSchemaVocabulary({ preference_types: ["research"] });

    expect(isKnownSchemaToken(vocab, "preference_types", "preference")).toBe(
      true,
    );
    expect(isKnownSchemaToken(vocab, "preference_types", "Research")).toBe(
      true,
    );
    expect(isKnownSchemaToken(vocab, "preference_types", "unknown")).toBe(
      false,
    );
    expect(isKnownSchemaToken(vocab, "signal_types", "research")).toBe(false);
  });

  test("validateSchemaDeclarations rejects invalid token shapes with field names", () => {
    expect(() =>
      validateSchemaDeclarations({
        preference_types: ["research", "../escape"],
      }),
    ).toThrow(SchemaVocabularyError);

    try {
      validateSchemaDeclarations({
        preference_types: ["research", "../escape"],
      });
      throw new Error("expected schema validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaVocabularyError);
      expect((err as SchemaVocabularyError).field).toBe(
        "schema.preference_types[1]",
      );
    }

    expect(() =>
      validateSchemaDeclarations({ signal_types: ["two words"] }),
    ).toThrow(/schema.signal_types\[0\]/);
    expect(() => validateSchemaDeclarations({ page_types: [""] })).toThrow(
      /schema.page_types\[0\]/,
    );
  });
});
