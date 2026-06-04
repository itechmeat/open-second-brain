/**
 * Exact-match quantity aggregation (t_220c313e): totals combine ONLY
 * values whose (entity, action, unit) tuple matches exactly after
 * canonical normalization - merely nearby numbers (different unit,
 * different action, text-kind slots) never pollute a total.
 */

import { describe, expect, test } from "bun:test";

import { aggregateQuantities } from "../../../../src/core/brain/truth/aggregate.ts";
import { computeTruthState } from "../../../../src/core/brain/truth/fold.ts";
import type { ClaimEvent, ClaimQuantity } from "../../../../src/core/brain/truth/types.ts";

function quantityClaim(
  aspect: string,
  quantity: ClaimQuantity,
  over: Partial<ClaimEvent> = {},
): ClaimEvent {
  return {
    v: 1,
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "operator",
    aspect,
    value: String(quantity.value),
    valueKind: "quantity",
    quantity,
    source: `[[Brain/notes/${aspect.replace(/\s+/g, "-")}.md]]`,
    ...over,
  };
}

const SLOTS = computeTruthState([
  quantityClaim("hosting spend may", { value: 120, unit: "usd", action: "spent" }),
  quantityClaim("domain spend may", { value: 42, unit: "usd", action: "spent" }),
  quantityClaim("hosting spend april", { value: 100, unit: "eur", action: "spent" }),
  quantityClaim("migration hours", { value: 6.5, unit: "hours", action: "worked" }),
  quantityClaim("deploy count", { value: 3, unit: "deployments", action: "ran" }),
  {
    v: 1,
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "operator",
    aspect: "favourite number",
    value: "7",
    valueKind: "text",
    source: "[[Brain/notes/text.md]]",
  },
]).slots;

describe("aggregateQuantities", () => {
  test("sums only exact (entity, action, unit) matches", () => {
    const result = aggregateQuantities(SLOTS, {
      entity: "operator",
      action: "spent",
      unit: "usd",
    });
    expect(result.total).toBe(162);
    expect(result.count).toBe(2);
    expect(result.contributions.map((c) => c.value)).toEqual([42, 120]);
  });

  test("different units never combine", () => {
    const eur = aggregateQuantities(SLOTS, { entity: "operator", action: "spent", unit: "eur" });
    expect(eur.total).toBe(100);
    expect(eur.count).toBe(1);
  });

  test("text-kind slots and other actions are excluded", () => {
    const worked = aggregateQuantities(SLOTS, {
      entity: "operator",
      action: "worked",
      unit: "hours",
    });
    expect(worked.total).toBe(6.5);
    expect(worked.count).toBe(1);
  });

  test("normalization makes the match case- and whitespace-insensitive", () => {
    const result = aggregateQuantities(SLOTS, {
      entity: "  Operator ",
      action: "SPENT",
      unit: " USD ",
    });
    expect(result.total).toBe(162);
  });

  test("entity filter is optional (all entities combine when omitted)", () => {
    const withOther = computeTruthState([
      quantityClaim("hosting spend", { value: 10, unit: "usd", action: "spent" }),
      quantityClaim(
        "infra spend",
        { value: 5, unit: "usd", action: "spent" },
        { entity: "team atlas" },
      ),
    ]).slots;
    const result = aggregateQuantities(withOther, { action: "spent", unit: "usd" });
    expect(result.total).toBe(15);
  });

  test("null unit matches only null unit", () => {
    const unitless = computeTruthState([
      quantityClaim("misc paid", { value: 42, unit: null, action: "paid" }),
      quantityClaim("hosting paid", { value: 10, unit: "usd", action: "paid" }),
    ]).slots;
    const result = aggregateQuantities(unitless, { action: "paid", unit: null });
    expect(result.total).toBe(42);
    expect(result.count).toBe(1);
  });

  test("no matches aggregate to a zero envelope", () => {
    const result = aggregateQuantities(SLOTS, { action: "earned", unit: "usd" });
    expect(result.total).toBe(0);
    expect(result.count).toBe(0);
    expect(result.contributions).toEqual([]);
  });

  test("contributions carry provenance and sort deterministically", () => {
    const result = aggregateQuantities(SLOTS, {
      entity: "operator",
      action: "spent",
      unit: "usd",
    });
    expect(result.contributions[0]!.source).toBe("[[Brain/notes/domain-spend-may.md]]");
    expect(result.contributions.map((c) => c.aspect)).toEqual([
      "domain spend may",
      "hosting spend may",
    ]);
  });
});
