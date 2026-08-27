/**
 * Ranked query mode on the context-pack lane (v1.53.0).
 *
 * The lane's only query facility was a case-insensitive SUBSTRING match of
 * the whole query against `topic + principle`, so a natural-language turn
 * `filter-miss`ed every candidate and the pack came back empty. Ranked mode
 * ORDERS the already-collected candidates by structural token overlap
 * instead of excluding them, which keeps the guard, the curated pool, the
 * tip preference, the owner scope, the budget, and the receipt that only
 * exist on this lane.
 *
 * Claims pinned here:
 *   1. `queryMode` absent is byte-identical to `queryMode: "substring"` -
 *      the substring filter, and its `filter-miss` skips, are untouched.
 *   2. A natural-language turn substring-misses everything (the defect).
 *   3. Ranked mode excludes nothing: no `filter-miss` skip is ever emitted.
 *   4. Ranked mode orders the query-relevant candidate first WITHIN its tier.
 *   5. Tier stays the coarse gate: a relevant peripheral page never outranks
 *      an irrelevant core one.
 *   6. Under a budget that fits one page, ranked mode spends it on the
 *      relevant page and reports the rest as `over-budget`, not `filter-miss`.
 *   7. `queryMode: "ranked"` with no query changes nothing.
 *   8. Receipt emission and the character budget are unaffected by the mode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packContext } from "../../../src/core/brain/context-pack.ts";

let vault: string;

const PRICING_TURN = "which pricing rule applies to this enterprise quote";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pack-ranked-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(
  slug: string,
  fields: { topic: string; principle: string; tier?: string; created_at?: string; body?: string },
): void {
  const lines = [
    "---",
    `id: pref-${slug}`,
    `topic: ${fields.topic}`,
    `principle: ${fields.principle}`,
  ];
  if (fields.tier) lines.push(`tier: ${fields.tier}`);
  lines.push(`created_at: ${fields.created_at ?? "2026-01-01T00:00:00Z"}`);
  lines.push("---", "", fields.body ?? fields.principle);
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"));
}

/** Three core preferences, only one of which is about pricing. */
function writeThreeCorePreferences(): void {
  writePref("deploy", {
    topic: "deployment window",
    principle: "never ship on friday",
    tier: "core",
    created_at: "2026-01-03T00:00:00Z",
  });
  writePref("pricing", {
    topic: "pricing rules",
    principle: "quote the enterprise tier before applying any discount",
    tier: "core",
    created_at: "2026-01-02T00:00:00Z",
  });
  writePref("imports", {
    topic: "module imports",
    principle: "use explicit imports only",
    tier: "core",
    created_at: "2026-01-01T00:00:00Z",
  });
}

describe("context pack ranked query mode", () => {
  test("an absent queryMode is byte-identical to the substring default", () => {
    writeThreeCorePreferences();
    const absent = packContext(vault, { maxTokens: 10_000, query: "pricing" });
    const explicit = packContext(vault, {
      maxTokens: 10_000,
      query: "pricing",
      queryMode: "substring",
    });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(absent));
    expect(absent.items.map((i) => i.id)).toEqual(["pref-pricing"]);
    expect(absent.skipped.map((s) => s.reason)).toEqual(["filter-miss", "filter-miss"]);
  });

  test("substring mode misses every candidate on a natural-language turn", () => {
    writeThreeCorePreferences();
    const r = packContext(vault, { maxTokens: 10_000, query: PRICING_TURN });
    expect(r.items).toEqual([]);
    expect(r.skipped.every((s) => s.reason === "filter-miss")).toBe(true);
    expect(r.skipped.length).toBe(3);
  });

  test("ranked mode excludes nothing and orders the relevant page first", () => {
    writeThreeCorePreferences();
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: PRICING_TURN,
      queryMode: "ranked",
    });
    expect(r.skipped).toEqual([]);
    expect(r.items.map((i) => i.id)).toEqual(["pref-pricing", "pref-deploy", "pref-imports"]);
  });

  test("tier stays the coarse gate over relevance", () => {
    writePref("pricing", {
      topic: "pricing rules",
      principle: "quote the enterprise tier before applying any discount",
      tier: "peripheral",
    });
    writePref("deploy", {
      topic: "deployment window",
      principle: "never ship on friday",
      tier: "core",
    });
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: PRICING_TURN,
      queryMode: "ranked",
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-deploy", "pref-pricing"]);
  });

  test("a budget that fits one page is spent on the relevant page", () => {
    writeThreeCorePreferences();
    const full = packContext(vault, {
      maxTokens: 10_000,
      query: PRICING_TURN,
      queryMode: "ranked",
    });
    const pricingTokens = full.items.find((i) => i.id === "pref-pricing")!.tokens;
    const r = packContext(vault, {
      maxTokens: pricingTokens,
      query: PRICING_TURN,
      queryMode: "ranked",
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-pricing"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["over-budget", "over-budget"]);
  });

  test("ranked mode with no query leaves the default ordering untouched", () => {
    writeThreeCorePreferences();
    const plain = packContext(vault, { maxTokens: 10_000 });
    const ranked = packContext(vault, { maxTokens: 10_000, queryMode: "ranked" });
    expect(JSON.stringify(ranked)).toBe(JSON.stringify(plain));
  });

  test("the receipt and the character budget survive ranked mode", () => {
    writeThreeCorePreferences();
    const r = packContext(vault, {
      maxTokens: 10_000,
      query: PRICING_TURN,
      queryMode: "ranked",
      maxCharsPerMemory: 12,
      receipt: { trigger: "context_pack", host: "hermes" },
    });
    expect(typeof r.receiptId).toBe("string");
    expect(r.receiptId!.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.trimmed)).toBe(true);
    expect(r.items.every((i) => i.body.length <= 12)).toBe(true);
  });
});
