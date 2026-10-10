/**
 * The one shared tag rule (src/core/tags.ts) - review-round regression
 * pins. v1.78.0 shipped the rule with an ASCII letter/underscore onset,
 * which refused Obsidian-valid Unicode tags (#кодинг) and digit-led
 * non-numeric tags (#2fa, #2024-notes) at the write sites and froze
 * every dream refresh or rewrite carrying such a scope over. The rule
 * is Obsidian's documented grammar now; these tests round-trip the
 * anchored predicate against what the index regex captures so the two
 * anchorings cannot drift apart again, and pin the slug composer's
 * output against the same rule (the composer is what repairs legacy
 * topics when a preference or signal is rewritten).
 */

import { describe, expect, test } from "bun:test";

import { TAG_RE, extractTagValues, isObsidianTagValue, stripCode } from "../../src/core/tags.ts";
import { slugify } from "../../src/core/vault.ts";

/** The single tag value TAG_RE captures from `text`, or null. */
function capturedTag(text: string): string | null {
  const match = TAG_RE.exec(text);
  TAG_RE.lastIndex = 0;
  return match?.[2] ?? null;
}

describe("isObsidianTagValue — Obsidian's documented grammar", () => {
  test("accepts plain, nested, underscore-onset, and dashed values", () => {
    expect(isObsidianTagValue("brain")).toBe(true);
    expect(isObsidianTagValue("brain/signal")).toBe(true);
    expect(isObsidianTagValue("a/b/c")).toBe(true);
    expect(isObsidianTagValue("_under")).toBe(true);
    expect(isObsidianTagValue("Foo_1-b/c")).toBe(true);
  });

  test("accepts Unicode tags", () => {
    expect(isObsidianTagValue("кодинг")).toBe(true);
    expect(isObsidianTagValue("réunion")).toBe(true);
    expect(isObsidianTagValue("中文")).toBe(true);
  });

  test("accepts digit-led non-numeric values", () => {
    expect(isObsidianTagValue("2fa")).toBe(true);
    expect(isObsidianTagValue("2024-notes")).toBe(true);
    expect(isObsidianTagValue("3d-print")).toBe(true);
  });

  test("refuses bare numbers - a number is not a tag", () => {
    expect(isObsidianTagValue("2024")).toBe(false);
    expect(isObsidianTagValue("42")).toBe(false);
    // Digits are digits in any script: the guard is \p{Nd}, not [0-9].
    expect(isObsidianTagValue("٢٠٢٤")).toBe(false);
  });

  test("slash characters themselves satisfy the non-digit requirement", () => {
    // Every segment is numeric but the nesting slashes are not digits -
    // the value carries a non-digit character, so it is a tag.
    expect(isObsidianTagValue("12/34")).toBe(true);
    expect(isObsidianTagValue("12/34/56")).toBe(true);
  });

  test("still refuses spaces, specials, empty values, and a leading slash", () => {
    expect(isObsidianTagValue("foo bar")).toBe(false);
    expect(isObsidianTagValue("foo bar/baz")).toBe(false);
    expect(isObsidianTagValue("foo.bar")).toBe(false);
    expect(isObsidianTagValue("foo+bar")).toBe(false);
    expect(isObsidianTagValue("")).toBe(false);
    expect(isObsidianTagValue("/leading")).toBe(false);
  });
});

describe("TAG_RE round-trips the predicate", () => {
  test("every accepted value is captured from prose whole", () => {
    const accepted = [
      "brain",
      "brain/signal",
      "a/b/c",
      "_under",
      "Foo_1-b/c",
      "trail-",
      "кодинг",
      "réunion",
      "中文",
      "2fa",
      "2024-notes",
      "3d-print",
      "2фы",
      "12/34",
    ];
    for (const value of accepted) {
      expect(capturedTag(`x #${value}`)).toBe(value);
    }
  });

  test("no refused value is captured whole", () => {
    const refused = ["", "2024", "42", "٢٠٢٤", "foo bar", "foo.bar", "/leading"];
    for (const value of refused) {
      expect(capturedTag(`x #${value}`)).not.toBe(value);
    }
  });

  test("the prose boundary is unchanged: word#nope is still no tag", () => {
    expect(capturedTag("word#nope")).toBeNull();
  });

  test("the index extraction carries digit-led and Unicode tags", () => {
    expect(extractTagValues("#2fa and #2024-notes plus #кодинг")).toEqual([
      "2fa",
      "2024-notes",
      "кодинг",
    ]);
  });

  test("bare numbers and slash onsets stay out of the extraction", () => {
    expect(extractTagValues("#2024 issue #/x but #real")).toEqual(["real"]);
  });

  test("Unicode tags ride the shared code cleaning like ASCII ones", () => {
    expect(extractTagValues(stripCode("```\n#кодинг\n```\n\n#тodos"))).toEqual(["тodos"]);
    expect(extractTagValues(stripCode("inline `#закодирован` and #реальный"))).toEqual([
      "реальный",
    ]);
  });
});

describe("the slug composer's output obeys the one tag rule", () => {
  // The preference and signal composers slugify the topic segment before
  // validating it against this rule, so a rewrite carrying a legacy
  // topic over is repaired by the composer - except a purely numeric
  // slug, which the rule still refuses. Pin the agreement so the two
  // modules cannot drift.
  test("slugified topics satisfy the rule unless the slug is purely numeric", () => {
    for (const topic of ["Кодинг", "2024 retrospective", "foo bar", "тестовый запрос"]) {
      const slug = slugify(topic);
      expect(isObsidianTagValue(slug)).toBe(!/^\d+$/.test(slug));
    }
    // The digit-led slug the old onset refused on every dream rewrite.
    expect(slugify("2024 retrospective")).toBe("2024-retrospective");
    expect(isObsidianTagValue("2024-retrospective")).toBe(true);
  });
});
