/**
 * Quantitative fact family (t_220c313e): first-person framed numeric
 * facts (actor + measured action + value + unit) join the extraction
 * families, with a deterministic structurer that turns a captured
 * span into a typed quantity. Precision-first like every other
 * family: bare numbers without an actor frame never extract.
 */

import { describe, expect, test } from "bun:test";

import { extractFacts, parseQuantityFact } from "../../../src/core/brain/fact-extract.ts";

describe("extractFacts quantity family", () => {
  test("first-person spend extracts as a quantity fact", () => {
    const facts = extractFacts("I spent 120 USD on hosting last month.");
    const quantity = facts.filter((f) => f.family === "quantity");
    expect(quantity).toHaveLength(1);
    expect(quantity[0]!.text).toContain("spent 120 USD on hosting");
  });

  test("first-person counts and durations extract", () => {
    const ran = extractFacts("We ran 3 deployments this week.");
    expect(ran.some((f) => f.family === "quantity")).toBe(true);
    const worked = extractFacts("I worked 6.5 hours on the migration.");
    expect(worked.some((f) => f.family === "quantity")).toBe(true);
  });

  test("bare numbers without an actor frame never extract", () => {
    const facts = extractFacts("There are 3 ways to deploy. The build takes 12 minutes.");
    expect(facts.filter((f) => f.family === "quantity")).toHaveLength(0);
  });

  test("existing families keep extracting unchanged", () => {
    const facts = extractFacts("My name is Ada Lovelace. I prefer tabs over spaces.");
    expect(facts.some((f) => f.family === "identity")).toBe(true);
    expect(facts.some((f) => f.family === "preference")).toBe(true);
  });
});

describe("parseQuantityFact", () => {
  test("structures action, value, and unit", () => {
    expect(parseQuantityFact("I spent 120 USD on hosting")).toEqual({
      action: "spent",
      value: 120,
      unit: "usd",
    });
    expect(parseQuantityFact("We ran 3 deployments this week")).toEqual({
      action: "ran",
      value: 3,
      unit: "deployments",
    });
    expect(parseQuantityFact("I worked 6.5 hours on the migration")).toEqual({
      action: "worked",
      value: 6.5,
      unit: "hours",
    });
  });

  test("dollar sign normalizes to usd", () => {
    expect(parseQuantityFact("I paid $42 for the domain")).toEqual({
      action: "paid",
      value: 42,
      unit: "usd",
    });
  });

  test("stop-words after the number leave the unit null", () => {
    expect(parseQuantityFact("I paid 42 for the domain")).toEqual({
      action: "paid",
      value: 42,
      unit: null,
    });
  });

  test("non-quantity text parses to null", () => {
    expect(parseQuantityFact("I prefer tabs over spaces")).toBeNull();
    expect(parseQuantityFact("")).toBeNull();
  });
});
