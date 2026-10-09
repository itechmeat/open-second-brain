/**
 * Tag syntax helper (trust-surface-hardening wave; kanban t_11ee559f).
 *
 * The write-time predicate judges a composed tag VALUE against the ONE
 * shared rule defined in `src/core/tags.ts` (`isObsidianTagValue`,
 * derived from `TAG_RE`). These tests pin three things:
 *
 *  1. the rule itself: `/` nesting accepted, spaces and other specials
 *     rejected, leading slash rejected, pure-numeric values rejected;
 *  2. the predicate is DERIVED from the index rule, not a parallel
 *     spelling: over a battery of values it agrees exactly with what
 *     `TAG_RE` captures, and `tag-syntax.ts` imports the shared
 *     predicate rather than redefining it;
 *  3. the typed refusal is shaped like `SchemaVocabularyError`: a stable
 *     error name plus structured `field` / `token`, the field named so
 *     a caller knows which input to fix.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TAG_RE, isObsidianTagValue as sharedPredicate } from "../../../src/core/tags.ts";
import {
  TagSyntaxError,
  isObsidianTagValue,
  requireObsidianTagValue,
} from "../../../src/core/brain/tag-syntax.ts";

describe("isObsidianTagValue — the one shared rule", () => {
  test("accepts plain, nested, and underscore-onset values", () => {
    expect(isObsidianTagValue("brain")).toBe(true);
    expect(isObsidianTagValue("brain/signal")).toBe(true);
    expect(isObsidianTagValue("a/b/c")).toBe(true);
    expect(isObsidianTagValue("_under")).toBe(true);
    expect(isObsidianTagValue("Foo_1-b/c")).toBe(true);
  });

  test("rejects spaces and other specials", () => {
    expect(isObsidianTagValue("foo bar")).toBe(false);
    expect(isObsidianTagValue("foo bar/baz")).toBe(false);
    expect(isObsidianTagValue("foo.bar")).toBe(false);
    expect(isObsidianTagValue("foo+bar")).toBe(false);
    expect(isObsidianTagValue("")).toBe(false);
  });

  test("rejects a leading slash and pure-numeric values", () => {
    expect(isObsidianTagValue("/leading")).toBe(false);
    expect(isObsidianTagValue("2024")).toBe(false);
    expect(isObsidianTagValue("2024-notes")).toBe(false);
  });

  test("the predicate agrees exactly with what TAG_RE captures (derived, not copied)", () => {
    const battery = [
      "brain",
      "brain/signal",
      "a/b/c",
      "_under",
      "Foo_1-b/c",
      "foo bar",
      "foo bar/baz",
      "foo.bar",
      "/leading",
      "2024",
      "2024-notes",
      "",
      "trail-",
      "UPPER",
    ];
    for (const value of battery) {
      const match = TAG_RE.exec(`x #${value}`);
      TAG_RE.lastIndex = 0;
      const captured = match !== null && match[2] === value;
      expect(isObsidianTagValue(value)).toBe(captured);
    }
  });
});

describe("the predicate is shared, never redefined", () => {
  test("tag-syntax.ts hands back the very function src/core/tags.ts defines", () => {
    expect(isObsidianTagValue).toBe(sharedPredicate);
  });

  test("source shape: tag-syntax.ts imports the rule and spells no rule of its own", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../src/core/brain/tag-syntax.ts"),
      "utf8",
    );
    expect(source).toMatch(/from "\.\.\/tags\.ts"/);
    // A redefinition would need either a regex construction or the
    // index rule's own onset charset; neither may appear here.
    expect(source).not.toContain("new RegExp");
    expect(source).not.toContain("[A-Za-z_]");
  });
});

describe("requireObsidianTagValue / TagSyntaxError", () => {
  test("a valid value passes through unchanged", () => {
    expect(requireObsidianTagValue("brain/topic/x", "topic")).toBe("brain/topic/x");
  });

  test("an invalid value throws with the error name and the field named", () => {
    let thrown: unknown;
    try {
      requireObsidianTagValue("foo bar", "extraTags");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TagSyntaxError);
    const err = thrown as TagSyntaxError;
    expect(err.name).toBe("TagSyntaxError");
    expect(err.field).toBe("extraTags");
    expect(err.token).toBe("foo bar");
    // The message names the FIELD and the rule; the offending token rides
    // the structured `token` property (SchemaVocabularyError's shape).
    expect(err.message).toBe(
      "extraTags: must start with a letter or underscore and contain only " +
        "letters, numbers, dashes, underscores, or slashes (never only digits)",
    );
  });
});
