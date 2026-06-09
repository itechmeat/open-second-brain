/**
 * Quantity family (t_220c313e; language-agnostic in t_80cbefa1). A
 * quantity is a number bound to a language-neutral unit symbol: a
 * leading currency glyph, a trailing ISO-4217 code, or a percent sign.
 * The English actor/action frame and grammar stop-word list were
 * removed. Precision-first: a bare number with no unit never extracts.
 */

import { describe, expect, test } from "bun:test";

import { extractFacts, parseQuantityFact } from "../../../src/core/brain/fact-extract.ts";

describe("extractFacts quantity family", () => {
  test("unit-bound amounts extract regardless of surrounding language", () => {
    expect(extractFacts("hosting cost $120 last month").some((f) => f.family === "quantity")).toBe(
      true,
    );
    expect(
      extractFacts("стоимость хостинга составила $120").some((f) => f.family === "quantity"),
    ).toBe(true);
    expect(extractFacts("budget is 3.5 USD per call").some((f) => f.family === "quantity")).toBe(
      true,
    );
    expect(extractFacts("conversion hit 50% this week").some((f) => f.family === "quantity")).toBe(
      true,
    );
  });

  test("bare numbers with no unit never extract", () => {
    expect(
      extractFacts("There are 3 ways to deploy. The build takes 12 minutes.").filter(
        (f) => f.family === "quantity",
      ),
    ).toHaveLength(0);
    // English action verbs no longer frame a quantity.
    expect(
      extractFacts("I spent 120 on hosting and ran 3 jobs").filter((f) => f.family === "quantity"),
    ).toHaveLength(0);
  });
});

describe("parseQuantityFact", () => {
  test("leading currency glyph maps to its ISO code", () => {
    expect(parseQuantityFact("paid $42 for the domain")).toEqual({ value: 42, unit: "usd" });
    expect(parseQuantityFact("€50 budget")).toEqual({ value: 50, unit: "eur" });
    expect(parseQuantityFact("£9.99 plan")).toEqual({ value: 9.99, unit: "gbp" });
    expect(parseQuantityFact("¥1000 fee")).toEqual({ value: 1000, unit: "jpy" });
  });

  test("trailing ISO code lowercases to the unit", () => {
    expect(parseQuantityFact("budget is 3.5 USD per call")).toEqual({ value: 3.5, unit: "usd" });
  });

  test("percent normalizes to percent", () => {
    expect(parseQuantityFact("up 50% this week")).toEqual({ value: 50, unit: "percent" });
  });

  test("a number with no unit symbol parses to null", () => {
    expect(parseQuantityFact("I paid 42 for the domain")).toBeNull();
    expect(parseQuantityFact("there are 3 ways")).toBeNull();
    expect(parseQuantityFact("")).toBeNull();
  });
});
