/**
 * Opt-in packing policy on the context-pack lane (recall-lane-latency
 * wave).
 *
 * Inside one pack, the preference-derived candidates and the page
 * candidates (the retired directory) share the single `maxTokens`
 * budget. A caller that names a `packingPolicy` decides which lane
 * claims that budget first: `facts_first` (the distilled preference
 * layer) or `query_first` (the pages lane). Every claim here:
 *
 *   1. An ABSENT `packingPolicy` is byte-identical to the unified
 *      comparator pack - no partition runs, no `packing` key exists,
 *      and a retired core page still outranks a newer supporting
 *      preference across lanes.
 *   2. With a policy, the report carries both lane spends and the
 *      policy name, and the lane order decides emission order.
 *   3. Skip reasons keep the shipped vocabulary; lane overflow is an
 *      `over-budget` skip, never a new reason.
 *   4. A policy against an empty lane is refused BY NAME before any
 *      receipt or telemetry is written - never a silent no-op.
 *   5. The zero-budget early return and the char-budget path agree
 *      with the one finalize funnel: the packing accounting is present
 *      on every return path once the policy is named.
 *   6. The synthesized attention block stays a reserved charge against
 *      the shared total, drawn by neither lane.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContextPackPackingLaneEmptyError,
  packContext,
  type ContextPackReport,
} from "../../../src/core/brain/context-pack.ts";
import { listAttentionFlows } from "../../../src/core/brain/attention-flows.ts";
import { listContextReceipts } from "../../../src/core/brain/context-receipts.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pack-packing-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(
  slug: string,
  fields: { tier: string; created_at: string; principle?: string },
): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      `id: pref-${slug}`,
      `topic: pref ${slug} topic`,
      `principle: ${fields.principle ?? `pref ${slug} principle`}`,
      `tier: ${fields.tier}`,
      `created_at: ${fields.created_at}`,
      "---",
      "",
      `body of pref ${slug}`,
    ].join("\n"),
  );
}

function writeRetired(slug: string, fields: { tier: string; created_at: string }): void {
  writeFileSync(
    join(vault, "Brain", "retired", `ret-${slug}.md`),
    [
      "---",
      `id: ret-${slug}`,
      `topic: ret ${slug} topic`,
      "principle: retired page principle",
      `tier: ${fields.tier}`,
      `created_at: ${fields.created_at}`,
      "---",
      "",
      `body of ret ${slug}`,
    ].join("\n"),
  );
}

/** One preference lane pair and one retired page, over distinct tiers and dates. */
function writeMixedVault(): void {
  writePref("alpha", { tier: "core", created_at: "2026-03-01T00:00:00Z" });
  writePref("beta", { tier: "supporting", created_at: "2026-02-01T00:00:00Z" });
  writeRetired("old", { tier: "core", created_at: "2026-01-01T00:00:00Z" });
}

function tokensOf(report: ContextPackReport, id: string): number {
  const item = report.items.find((i) => i.id === id);
  if (item) return item.tokens;
  const skip = report.skipped.find((s) => s.id === id);
  if (skip) return skip.tokens;
  throw new Error(`fixture page not in report: ${id}`);
}

interface PackingShape {
  policy: string;
  pages: { allocation: number; spent: number; candidates: number; items: number };
  facts: { allocation: number; spent: number; candidates: number; items: number };
}

function packingOf(report: ContextPackReport): PackingShape {
  return report.packing as unknown as PackingShape;
}

describe("context pack packing policy", () => {
  test("an absent packingPolicy keeps the unified comparator pack byte-identical", () => {
    writeMixedVault();
    const r = packContext(vault, { maxTokens: 10_000 });
    // Unified order: tier first, recency inside the tier - the retired
    // core page sits between the two preferences exactly as before any
    // partition existed, and no packing key exists at all.
    expect(r.items.map((i) => i.id)).toEqual(["pref-alpha", "ret-old", "pref-beta"]);
    expect(JSON.stringify(r)).not.toContain('"packing"');
    expect(Object.hasOwn(r, "packing")).toBe(false);
  });

  test("facts_first lets the facts lane claim first and the report carries both spends", () => {
    writeMixedVault();
    const unified = packContext(vault, { maxTokens: 10_000 });
    const r = packContext(vault, { maxTokens: 10_000, packingPolicy: "facts_first" });
    // Same population, different order: the preference lane emits as a
    // block before the retired page, which the unified order slotted by
    // tier alone.
    expect(r.items.map((i) => i.id)).toEqual(["pref-alpha", "pref-beta", "ret-old"]);
    expect(r.skipped).toEqual([]);
    const packing = packingOf(r);
    expect(packing.policy).toBe("facts_first");
    expect(packing.facts.spent).toBe(
      tokensOf(unified, "pref-alpha") + tokensOf(unified, "pref-beta"),
    );
    expect(packing.pages.spent).toBe(tokensOf(unified, "ret-old"));
    expect(packing.facts.items).toBe(2);
    expect(packing.pages.items).toBe(1);
    // Conservation, reserved charge (zero here) included.
    expect(packing.facts.allocation + packing.pages.allocation).toBe(10_000);
    expect(packing.facts.spent + packing.pages.spent).toBe(r.tokensUsed);
  });

  test("query_first hands the first claim to the pages lane", () => {
    writeMixedVault();
    const unified = packContext(vault, { maxTokens: 10_000 });
    const retTokens = tokensOf(unified, "ret-old");
    const r = packContext(vault, { maxTokens: retTokens, packingPolicy: "query_first" });
    expect(r.items.map((i) => i.id)).toEqual(["ret-old"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["over-budget", "over-budget"]);
    const packing = packingOf(r);
    expect(packing.policy).toBe("query_first");
    expect(packing.pages.allocation).toBe(retTokens);
    expect(packing.pages.spent).toBe(retTokens);
    expect(packing.facts.allocation).toBe(0);
    expect(packing.facts.spent).toBe(0);
  });

  test("facts_first on a tight budget spends it on the facts lane", () => {
    writeMixedVault();
    const unified = packContext(vault, { maxTokens: 10_000 });
    const factsDemand = tokensOf(unified, "pref-alpha") + tokensOf(unified, "pref-beta");
    const r = packContext(vault, { maxTokens: factsDemand, packingPolicy: "facts_first" });
    expect(r.items.map((i) => i.id)).toEqual(["pref-alpha", "pref-beta"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["over-budget"]);
    const packing = packingOf(r);
    expect(packing.facts.allocation).toBe(factsDemand);
    expect(packing.pages.allocation).toBe(0);
  });

  test("skip reasons keep the shipped vocabulary under a policy", () => {
    // Both lanes hold a query match, so the pack runs; the two misses
    // filter-miss per lane and the losing lane's overflow is an
    // over-budget. No new reason exists.
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-a.md"),
      [
        "---",
        "id: pref-a",
        "topic: needle in the facts",
        "principle: facts principle",
        "tier: core",
        "created_at: 2026-03-01T00:00:00Z",
        "---",
        "",
        "body",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-b.md"),
      [
        "---",
        "id: pref-b",
        "topic: other facts",
        "principle: more facts principle",
        "tier: core",
        "created_at: 2026-03-02T00:00:00Z",
        "---",
        "",
        "body",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "Brain", "retired", "ret-a.md"),
      [
        "---",
        "id: ret-a",
        "topic: needle in the pages",
        "principle: pages principle",
        "tier: core",
        "created_at: 2026-01-01T00:00:00Z",
        "---",
        "",
        "body",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "Brain", "retired", "ret-b.md"),
      [
        "---",
        "id: ret-b",
        "topic: unrelated page",
        "principle: unrelated principle",
        "tier: core",
        "created_at: 2026-01-02T00:00:00Z",
        "---",
        "",
        "body",
      ].join("\n"),
    );
    const unified = packContext(vault, { maxTokens: 10_000, query: "needle" });
    const needleTokens = tokensOf(unified, "pref-a");
    const r = packContext(vault, {
      maxTokens: needleTokens,
      packingPolicy: "facts_first",
      query: "needle",
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-a"]);
    const reasons = new Set(r.skipped.map((s) => s.reason));
    expect(reasons.has("filter-miss")).toBe(true);
    expect(reasons.has("over-budget")).toBe(true);
    for (const reason of reasons) {
      expect(["filter-miss", "over-budget", "over-char-budget", "guard-blocked"]).toContain(reason);
    }
  });

  test("a policy against an empty lane is refused by name and writes no receipt", () => {
    writePref("alpha", { tier: "core", created_at: "2026-03-01T00:00:00Z" });
    let caught: unknown = null;
    try {
      packContext(vault, {
        maxTokens: 10_000,
        packingPolicy: "facts_first",
        receipt: { trigger: "context_pack", host: "packing-test" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ContextPackPackingLaneEmptyError);
    const err = caught as Error;
    expect(err.message).toContain("pages");
    expect(err.message).toContain("facts_first");
    // The refusal ran before the funnel: no delivery record exists.
    expect(listContextReceipts(vault)).toHaveLength(0);
  });

  test("the refusal names the empty lane whichever lane it is", () => {
    writeRetired("old", { tier: "core", created_at: "2026-01-01T00:00:00Z" });
    expect(() => packContext(vault, { maxTokens: 10_000, packingPolicy: "query_first" })).toThrow(
      /facts lane is empty/,
    );
  });

  test("the zero-budget early return agrees with the funnel", () => {
    writeMixedVault();
    const r = packContext(vault, { maxTokens: 0, packingPolicy: "facts_first" });
    expect(r.items).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.tokensUsed).toBe(0);
    const packing = packingOf(r);
    expect(packing.policy).toBe("facts_first");
    expect(packing.facts.allocation).toBe(0);
    expect(packing.pages.allocation).toBe(0);
    expect(packing.facts.spent).toBe(0);
    expect(packing.pages.spent).toBe(0);
  });

  test("the char-budget path agrees with the funnel", () => {
    writeMixedVault();
    const unified = packContext(vault, { maxTokens: 10_000 });
    const retTokens = tokensOf(unified, "ret-old");
    // Keep every body, then cap the total so exactly the lowest-priority
    // final item (the retired page, emitted last) drops.
    const keptChars = [...`${"body of pref alpha"}${"body of pref beta"}`].length;
    const r = packContext(vault, {
      maxTokens: 10_000,
      packingPolicy: "facts_first",
      maxTotalChars: keptChars,
    });
    expect(r.items.map((i) => i.id)).toEqual(["pref-alpha", "pref-beta"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["over-char-budget"]);
    const packing = packingOf(r);
    expect(packing.pages.items).toBe(0);
    expect(packing.pages.spent).toBe(0);
    expect(packing.facts.spent).toBe(r.tokensUsed);
    expect(packing.facts.allocation + packing.pages.allocation).toBe(10_000);
    // The dropped page's own token cost left with it.
    expect(r.tokensUsed).toBeLessThan(unified.tokensUsed);
    expect(retTokens).toBeGreaterThan(0);
  });

  test("the attention block stays a reserved charge neither lane draws", () => {
    writeMixedVault();
    listAttentionFlows(vault); // bootstraps the default flow fixtures
    const r = packContext(vault, {
      maxTokens: 10_000,
      packingPolicy: "facts_first",
      attentionFlowIds: ["open-loops"],
    });
    expect(r.items[0]!.id).toBe("attention-flows");
    const attentionTokens = r.items[0]!.tokens;
    const packing = packingOf(r);
    // Conservation, reserved charge included: the two lane allocations
    // plus the attention block's charge fill the total exactly.
    expect(packing.facts.allocation + packing.pages.allocation + attentionTokens).toBe(10_000);
    expect(packing.facts.spent + packing.pages.spent + attentionTokens).toBe(r.tokensUsed);
  });
});
