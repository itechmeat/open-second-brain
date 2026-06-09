/**
 * Characterization tests for the canonical wikilink regex variants.
 *
 * Before the SOLID/DRY refactor, seven modules each declared their own
 * `[[...]]` regex; these tests pin the exact contract of every variant
 * so the consolidation into `src/core/brain/wikilink.ts` is provably
 * behavior-preserving for each former call site.
 */

import { describe, expect, test } from "bun:test";

import {
  ANCHORED_WIKILINK_RE,
  EXACT_WIKILINK_RE,
  RICH_WIKILINK_RE,
  WIKILINK_ALIAS_RE,
  WIKILINK_DETECT_RE,
  WIKILINK_TARGET_RE,
} from "../../../src/core/brain/wikilink.ts";

function allMatches(re: RegExp, text: string): RegExpMatchArray[] {
  return [...text.matchAll(re)];
}

describe("WIKILINK_TARGET_RE (vault.ts / lint-consolidate.ts contract)", () => {
  test("captures bare target and leaves suffix group empty", () => {
    const [m] = allMatches(WIKILINK_TARGET_RE, "see [[Note]] here");
    expect(m?.[1]).toBe("Note");
    expect(m?.[2]).toBeUndefined();
  });

  test("captures alias suffix separately from target", () => {
    const [m] = allMatches(WIKILINK_TARGET_RE, "[[Note|display text]]");
    expect(m?.[1]).toBe("Note");
    expect(m?.[2]).toBe("|display text");
  });

  test("captures heading suffix separately from target", () => {
    const [m] = allMatches(WIKILINK_TARGET_RE, "[[Note#Heading]]");
    expect(m?.[1]).toBe("Note");
    expect(m?.[2]).toBe("#Heading");
  });

  test("matches multiple links in one line", () => {
    const ms = allMatches(WIKILINK_TARGET_RE, "[[a]] and [[b]]");
    expect(ms.map((m) => m[1])).toEqual(["a", "b"]);
  });

  test("does not join two adjacent links", () => {
    const ms = allMatches(WIKILINK_TARGET_RE, "[[a]][[b]]");
    expect(ms.map((m) => m[1])).toEqual(["a", "b"]);
  });

  test("tolerates folder prefixes and dots in the target", () => {
    const [m] = allMatches(WIKILINK_TARGET_RE, "[[Folder/file.md]]");
    expect(m?.[1]).toBe("Folder/file.md");
  });

  test("pins historical behavior: target may span newlines", () => {
    // `[^\]|#]` does not exclude `\n`; vault.ts has always matched a
    // bracket pair that spans lines. Pinned, not endorsed.
    const ms = allMatches(WIKILINK_TARGET_RE, "[[a\nb]]");
    expect(ms.map((m) => m[1])).toEqual(["a\nb"]);
  });

  test("supports replace-based rewriting with suffix preservation", () => {
    const out = "x [[old#H]] y [[old|Alias]]".replace(
      WIKILINK_TARGET_RE,
      (_match, target: string, suffix: string | undefined) =>
        `[[${target === "old" ? "new" : target}${suffix ?? ""}]]`,
    );
    expect(out).toBe("x [[new#H]] y [[new|Alias]]");
  });
});

describe("WIKILINK_ALIAS_RE (search/links.ts and search/entities.ts contract)", () => {
  test("captures target and alias", () => {
    const [m] = allMatches(WIKILINK_ALIAS_RE, "[[Note|alias]]");
    expect(m?.[1]).toBe("Note");
    expect(m?.[2]).toBe("alias");
  });

  test("captures bare target with undefined alias", () => {
    const [m] = allMatches(WIKILINK_ALIAS_RE, "[[Note]]");
    expect(m?.[1]).toBe("Note");
    expect(m?.[2]).toBeUndefined();
  });

  test("keeps heading anchor inside the target capture", () => {
    // The alias-aware variant splits only on `|`; `#` stays in m[1].
    const [m] = allMatches(WIKILINK_ALIAS_RE, "[[Note#sec]]");
    expect(m?.[1]).toBe("Note#sec");
  });

  test("does not match across newlines", () => {
    expect(allMatches(WIKILINK_ALIAS_RE, "[[a\nb]]")).toHaveLength(0);
  });

  test("handles unicode targets and aliases", () => {
    const [m] = allMatches(WIKILINK_ALIAS_RE, "[[Проект 🚀|план]]");
    expect(m?.[1]).toBe("Проект 🚀");
    expect(m?.[2]).toBe("план");
  });
});

describe("RICH_WIKILINK_RE (link-graph parse/format contract)", () => {
  test("captures the full bracket body including alias and anchor", () => {
    const [m] = allMatches(RICH_WIKILINK_RE, "[[Note#Head|alias]]");
    expect(m?.[1]).toBe("Note#Head|alias");
  });

  test("does not collapse adjacent links into one match", () => {
    const ms = allMatches(RICH_WIKILINK_RE, "[[a]] mid [[b]]");
    expect(ms.map((m) => m[1])).toEqual(["a", "b"]);
  });

  test("does not match across newlines", () => {
    expect(allMatches(RICH_WIKILINK_RE, "[[a\nb]]")).toHaveLength(0);
  });

  test("supports replace-based rewriting of the body", () => {
    const out = "x [[a|b]] y".replace(
      RICH_WIKILINK_RE,
      (_m, body: string) => `[[${body.toUpperCase()}]]`,
    );
    expect(out).toBe("x [[A|B]] y");
  });
});

describe("WIKILINK_DETECT_RE (search/query-plan.ts contract)", () => {
  test("detects a wikilink anywhere in the string", () => {
    expect(WIKILINK_DETECT_RE.test("find [[Note]] please")).toBe(true);
  });

  test("rejects text without a complete bracket pair", () => {
    expect(WIKILINK_DETECT_RE.test("no link [here]")).toBe(false);
    expect(WIKILINK_DETECT_RE.test("[[unclosed")).toBe(false);
  });

  test("is not global, so repeated test() calls stay stateless", () => {
    expect(WIKILINK_DETECT_RE.global).toBe(false);
    expect(WIKILINK_DETECT_RE.test("[[a]]")).toBe(true);
    expect(WIKILINK_DETECT_RE.test("[[a]]")).toBe(true);
  });
});

describe("ANCHORED_WIKILINK_RE / EXACT_WIKILINK_RE (brain/wikilink.ts internals)", () => {
  test("anchored variant strips a leading wikilink prefix only", () => {
    const m = ANCHORED_WIKILINK_RE.exec("[[Note|alias]] trailing");
    expect(m?.[1]).toBe("Note|alias");
    expect(ANCHORED_WIKILINK_RE.exec("prose [[Note]]")).toBeNull();
  });

  test("exact variant requires the whole string to be one wikilink", () => {
    expect(EXACT_WIKILINK_RE.exec("[[Note]]")?.[1]).toBe("Note");
    expect(EXACT_WIKILINK_RE.exec("[[Note]] x")).toBeNull();
    expect(EXACT_WIKILINK_RE.exec(" [[Note]]")).toBeNull();
  });
});
