/**
 * Structural fact extraction. After the language-agnostic refactor the
 * extractor keeps only families detectable WITHOUT knowing any human
 * language: url, email, quantity (a number bound to a currency symbol,
 * an ISO-4217 code, or percent). Prose families that needed an English
 * frame (identity, preference, possession, location, confirmation) are
 * gone. Negative fixtures pin precision: code blocks, quoted lines, and
 * bare numbers never extract.
 */

import { describe, expect, test } from "bun:test";

import { extractFacts, factDedupHash } from "../../../src/core/brain/fact-extract.ts";

function families(text: string): string[] {
  return extractFacts(text).map((f) => f.family);
}

describe("extractFacts - structural families (language-neutral)", () => {
  test("url: a bare URL extracts regardless of surrounding language", () => {
    const en = extractFacts("see the writeup at https://techmeat.dev/post for details");
    expect(en.some((f) => f.family === "url" && f.text.includes("https://techmeat.dev/post"))).toBe(
      true,
    );
    // Non-Latin wrapper: same structural signal, same extraction.
    const ru = extractFacts("мой сайт https://techmeat.dev живёт на статике");
    expect(ru.some((f) => f.family === "url" && f.text.includes("https://techmeat.dev"))).toBe(
      true,
    );
  });

  test("email: a bare address extracts regardless of surrounding language", () => {
    const en = extractFacts("ping ada@example.com for anything urgent");
    expect(en.some((f) => f.family === "email" && f.text.includes("ada@example.com"))).toBe(true);
    const jp = extractFacts("連絡先は ada@example.com です");
    expect(jp.some((f) => f.family === "email" && f.text.includes("ada@example.com"))).toBe(true);
  });

  test("quantity: currency symbol, ISO code, and percent extract", () => {
    expect(families("the invoice was $1200 this month")).toContain("quantity");
    expect(families("стоимость проекта составила $1200")).toContain("quantity");
    expect(families("budget is 3.5 USD per call")).toContain("quantity");
    expect(families("conversion improved to 50% last week")).toContain("quantity");
  });
});

describe("extractFacts - precision (negative fixtures)", () => {
  test("English prose frames no longer extract (families removed)", () => {
    expect(families("Hi, my name is Ada Lovelace and I work here")).toEqual([]);
    expect(families("For diagrams I prefer the blueprint style")).toEqual([]);
    expect(families("my editor is Neovim with a custom config")).toEqual([]);
    expect(families("These days I live in Lisbon")).toEqual([]);
    expect(families("Correct, the production vault is on the VPS")).toEqual([]);
  });

  test("bare numbers without a unit never extract", () => {
    expect(families("we shipped 42 items and ran 7 jobs")).toEqual([]);
    expect(families("version 3 of the api")).toEqual([]);
  });

  test("code blocks never extract", () => {
    const text = [
      "Try this:",
      "```ts",
      'const url = "https://x.dev";',
      "const n = 50;",
      "```",
    ].join("\n");
    expect(families(text)).toEqual([]);
  });

  test("quoted lines never extract", () => {
    expect(families("> reach me at ada@example.com, said the old book")).toEqual([]);
  });

  test("empty and whitespace input", () => {
    expect(extractFacts("")).toEqual([]);
    expect(extractFacts("   \n  ")).toEqual([]);
  });
});

describe("extractFacts - hardening", () => {
  test("a long digit run does not blow up (no quadratic backtracking)", () => {
    const huge = "note " + "1".repeat(100_000);
    const start = performance.now();
    const out = extractFacts(huge);
    const elapsedMs = performance.now() - start;
    // No unit symbol -> not a quantity; and it must finish fast, not hang.
    expect(out.filter((f) => f.family === "quantity")).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("a URL's userinfo is not extracted as a phantom email", () => {
    const out = extractFacts("login at https://user:pass@host.example.com/path");
    expect(out.some((f) => f.family === "url")).toBe(true);
    expect(out.some((f) => f.family === "email")).toBe(false);
  });

  test("a number inside a URL is not extracted as a phantom quantity", () => {
    const out = extractFacts("open https://x.dev/p?q=foo&n=50USD now");
    expect(out.some((f) => f.family === "url")).toBe(true);
    expect(out.some((f) => f.family === "quantity")).toBe(false);
  });
});

describe("fact dedup hashing", () => {
  test("same fact hashes identically across whitespace and case variants", () => {
    const a = extractFacts("ping ADA@example.com now")[0]!;
    const b = extractFacts("ping   ada@example.com   now")[0]!;
    expect(factDedupHash(a)).toBe(factDedupHash(b));
  });

  test("different families never collide on the same text", () => {
    const url = { family: "url" as const, text: "https://x.dev", line: 1 };
    const email = { family: "email" as const, text: "https://x.dev", line: 1 };
    expect(factDedupHash(url)).not.toBe(factDedupHash(email));
  });

  test("extraction is deterministic", () => {
    const text = "site https://x.dev, mail a@b.dev, cost $5";
    expect(extractFacts(text)).toEqual(extractFacts(text));
  });
});
