/**
 * Regex fact extraction (Memory Integrity Suite, t_d0782ab2).
 *
 * Seven precision-first pattern families over USER turn text:
 * identity, preference, possession, location, url, email,
 * confirmation. Deterministic - no LLM, no clock. Negative fixtures
 * pin the precision contract: code blocks, quoted lines, and
 * assistant-shaped prose never extract.
 */

import { describe, expect, test } from "bun:test";

import { extractFacts, factDedupHash } from "../../../src/core/brain/fact-extract.ts";

function families(text: string): string[] {
  return extractFacts(text).map((f) => f.family);
}

describe("extractFacts - positive fixtures", () => {
  test("identity: my name is ...", () => {
    const out = extractFacts("Hi, my name is Ada Lovelace and I work on the vault.");
    expect(out.some((f) => f.family === "identity" && f.text.includes("Ada Lovelace"))).toBe(true);
  });

  test("preference: I prefer / I always use", () => {
    const out = extractFacts("For diagrams I prefer the vintage blueprint style.");
    expect(out.some((f) => f.family === "preference")).toBe(true);
    const out2 = extractFacts("I always use bun for this repository.");
    expect(out2.some((f) => f.family === "preference")).toBe(true);
  });

  test("possession: my <thing> is <value>", () => {
    const out = extractFacts("my editor is Neovim with a custom config");
    expect(out.some((f) => f.family === "possession" && f.text.includes("Neovim"))).toBe(true);
  });

  test("location: I live in / I am based in", () => {
    const out = extractFacts("These days I live in Lisbon most of the year.");
    expect(out.some((f) => f.family === "location" && f.text.includes("Lisbon"))).toBe(true);
  });

  test("url: possessively introduced site", () => {
    const out = extractFacts("my blog is https://techmeat.dev and it runs on a static site");
    expect(out.some((f) => f.family === "url" && f.text.includes("https://techmeat.dev"))).toBe(
      true,
    );
  });

  test("email: my email is ...", () => {
    const out = extractFacts("my email is ada@example.com for anything urgent");
    expect(out.some((f) => f.family === "email" && f.text.includes("ada@example.com"))).toBe(true);
  });

  test("confirmation: yes, the X is Y", () => {
    const out = extractFacts("Correct, the production vault is on the VPS at /srv/vault.");
    expect(out.some((f) => f.family === "confirmation")).toBe(true);
  });
});

describe("extractFacts - precision (negative fixtures)", () => {
  test("plain assistant-shaped prose extracts nothing", () => {
    expect(
      families(
        "The function resolves the vault path and returns the merged entries sorted by timestamp.",
      ),
    ).toEqual([]);
  });

  test("code blocks never extract", () => {
    const text = [
      "Try this:",
      "```ts",
      'const x = "my name is Bob";',
      "// I prefer tabs",
      "```",
    ].join("\n");
    expect(families(text)).toEqual([]);
  });

  test("quoted lines never extract", () => {
    expect(families("> my name is Bob, said the old book")).toEqual([]);
  });

  test("bare URLs without a possessive introduction never extract", () => {
    expect(families("see https://example.com/docs for details")).toEqual([]);
  });

  test("bare 'yes' without a restated fact never extracts", () => {
    expect(families("yes")).toEqual([]);
    expect(families("yes, please do that now")).toEqual([]);
  });

  test("empty and whitespace input", () => {
    expect(extractFacts("")).toEqual([]);
    expect(extractFacts("   \n  ")).toEqual([]);
  });
});

describe("fact dedup hashing", () => {
  test("same fact hashes identically across whitespace and case variants", () => {
    const a = extractFacts("my name is Ada")[0]!;
    const b = extractFacts("My name is   ada")[0]!;
    expect(factDedupHash(a)).toBe(factDedupHash(b));
  });

  test("different families never collide on the same text", () => {
    const id = extractFacts("my name is Lisbon")[0]!;
    const loc = extractFacts("I live in Lisbon")[0]!;
    expect(factDedupHash(id)).not.toBe(factDedupHash(loc));
  });

  test("extraction is deterministic", () => {
    const text = "my name is Ada. I prefer dark themes. my email is s@e.dev";
    expect(extractFacts(text)).toEqual(extractFacts(text));
  });
});
