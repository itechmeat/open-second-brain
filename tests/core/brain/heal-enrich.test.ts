/**
 * Heal-phase vault enrichment (Brain lifecycle suite, Feature 6).
 *
 * Deterministic, structural enrichment used in the dream heal phase:
 * derive a missing `title` from the page's first H1, and insert
 * wikilinks for EXACT whole-token title/alias matches to existing
 * pages. No inference, no language heuristics. Idempotent: existing
 * links and inline code are never re-linked. The whole feature is
 * gated off by default (`dream.heal_enrich_enabled`).
 */

import { describe, expect, test } from "bun:test";

import {
  deriveTitleFromContent,
  linkExactMentions,
  linkExactMentionsPrepared,
  planHealEnrichment,
  planHealEnrichmentPrepared,
  prepareHealPhrases,
} from "../../../src/core/brain/heal-enrich.ts";

describe("deriveTitleFromContent", () => {
  test("returns the first H1 text", () => {
    expect(deriveTitleFromContent("# Hello World\n\nbody")).toBe("Hello World");
  });
  test("ignores deeper headings and returns null when no H1", () => {
    expect(deriveTitleFromContent("## Sub\n\nbody")).toBeNull();
    expect(deriveTitleFromContent("plain body only")).toBeNull();
  });
  test("trims surrounding whitespace of the H1", () => {
    expect(deriveTitleFromContent("#    Spaced   \nx")).toBe("Spaced");
  });
});

describe("linkExactMentions", () => {
  const known = ["Acme Corp", "Widget"];

  test("wraps an exact whole-phrase match in a wikilink", () => {
    expect(linkExactMentions("We use Acme Corp daily", known)).toBe("We use [[Acme Corp]] daily");
  });

  test("is idempotent - never re-links an existing wikilink", () => {
    expect(linkExactMentions("We use [[Acme Corp]] daily", known)).toBe(
      "We use [[Acme Corp]] daily",
    );
  });

  test("does not link inside inline code spans", () => {
    expect(linkExactMentions("run `Widget` now", known)).toBe("run `Widget` now");
  });

  test("does not link inside fenced code blocks", () => {
    const body = "intro\n\n```\nuse Widget here\n```\n\nWidget outside";
    expect(linkExactMentions(body, known)).toBe(
      "intro\n\n```\nuse Widget here\n```\n\n[[Widget]] outside",
    );
  });

  test("does not link a partial token (Acme Corporation)", () => {
    expect(linkExactMentions("Acme Corporation rocks", known)).toBe("Acme Corporation rocks");
  });

  test("prefers the longest phrase at a position", () => {
    // "Acme Corp" should win over a hypothetical "Acme" entry.
    expect(linkExactMentions("Acme Corp ships", ["Acme", "Acme Corp"])).toBe("[[Acme Corp]] ships");
  });

  test("returns body unchanged with no known titles", () => {
    expect(linkExactMentions("Acme Corp", [])).toBe("Acme Corp");
  });

  test("is case-sensitive (exact match only)", () => {
    expect(linkExactMentions("acme corp lower", known)).toBe("acme corp lower");
  });
});

describe("planHealEnrichment", () => {
  test("plans a title completion when frontmatter has no title", () => {
    const plan = planHealEnrichment({ frontmatter: {}, body: "# Derived Title\n\ncontent" }, []);
    expect(plan.changed).toBe(true);
    expect(plan.title).toBe("Derived Title");
  });

  test("does not overwrite an existing title", () => {
    const plan = planHealEnrichment({ frontmatter: { title: "Kept" }, body: "# Other\n\nx" }, []);
    expect(plan.title).toBeUndefined();
  });

  test("plans a body rewrite when an exact mention can be linked", () => {
    const plan = planHealEnrichment({ frontmatter: { title: "Note" }, body: "see Widget here" }, [
      "Widget",
    ]);
    expect(plan.changed).toBe(true);
    expect(plan.body).toBe("see [[Widget]] here");
  });

  test("is a no-op (changed=false) when nothing to do", () => {
    const plan = planHealEnrichment({ frontmatter: { title: "Note" }, body: "nothing to link" }, [
      "Widget",
    ]);
    expect(plan.changed).toBe(false);
    expect(plan.title).toBeUndefined();
    expect(plan.body).toBeUndefined();
  });
});

describe("prepared-set path is byte-identical to the excluded-list path", () => {
  // Full known set; several phrases where one page's own multi-word title
  // ("Foo Bar") contains another known phrase ("Bar") as a whole sub-token
  // - the exact case where a naive compile-once-then-post-filter would
  // diverge. The prepared path must match the excluded-list reference.
  const known = ["Bar", "Foo Bar", "Acme Corp", "Acme", "Widget"];
  const bodies = [
    "Foo Bar mentions Bar and Widget here",
    "Acme Corp and Acme both appear, plus `Widget` in code",
    "[[Foo Bar]] already linked; Bar again",
    "nothing relevant",
    "Bar Foo Bar Bar",
  ];
  const excludeSets: ReadonlyArray<ReadonlyArray<string>> = [
    ["Foo Bar"], // page owns the multi-word title containing "Bar"
    ["Acme Corp"],
    [],
    ["Widget"],
    ["Bar"],
  ];

  const prepared = prepareHealPhrases(known);

  for (const body of bodies) {
    for (const exclude of excludeSets) {
      test(`link "${body.slice(0, 20)}" excluding [${exclude.join(",")}]`, () => {
        const reference = linkExactMentions(
          body,
          known.filter((k) => !new Set(exclude).has(k)),
        );
        const viaPrepared = linkExactMentionsPrepared(body, prepared, new Set(exclude));
        expect(viaPrepared).toBe(reference);
      });
    }
  }

  test("planHealEnrichmentPrepared matches planHealEnrichment on the excluded list", () => {
    const page = { frontmatter: { title: "Foo Bar" }, body: "Foo Bar links Bar and Widget" };
    const exclude = new Set(["Foo Bar"]);
    const reference = planHealEnrichment(
      page,
      known.filter((k) => !exclude.has(k)),
    );
    const viaPrepared = planHealEnrichmentPrepared(page, prepared, exclude);
    expect(viaPrepared).toEqual(reference);
  });
});
