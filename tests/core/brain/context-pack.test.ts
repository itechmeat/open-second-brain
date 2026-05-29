import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packContext } from "../../../src/core/brain/context-pack.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-context-pack-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(
  slug: string,
  fields: { topic: string; principle: string; tier?: string; created_at?: string },
) {
  const lines = [
    "---",
    `id: pref-${slug}`,
    `topic: ${fields.topic}`,
    `principle: ${fields.principle}`,
  ];
  if (fields.tier) lines.push(`tier: ${fields.tier}`);
  if (fields.created_at) lines.push(`created_at: ${fields.created_at}`);
  lines.push("---", "");
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"));
}

describe("packContext", () => {
  test("empty vault returns empty pack", () => {
    const r = packContext(vault, { maxTokens: 1000 });
    expect(r.tokensUsed).toBe(0);
    expect(r.items.length).toBe(0);
    expect(r.skipped.length).toBe(0);
  });

  test("maxCharsPerMemory trims an oversized page body and flags it trimmed", () => {
    const body = "x".repeat(500);
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-big.md"),
      ["---", "id: pref-big", "topic: t", "principle: p", "tier: core", "---", "", body].join("\n"),
    );

    const full = packContext(vault, { maxTokens: 100_000 });
    expect(full.items[0]!.trimmed).toBe(false);
    expect([...full.items[0]!.body].length).toBeGreaterThanOrEqual(500);

    const capped = packContext(vault, { maxTokens: 100_000, maxCharsPerMemory: 100 });
    expect([...capped.items[0]!.body].length).toBe(100);
    expect(capped.items[0]!.trimmed).toBe(true);
  });

  test("orders core → supporting → peripheral", () => {
    writePref("p", { topic: "x", principle: "peripheral one", tier: "peripheral" });
    writePref("s", { topic: "x", principle: "supporting one", tier: "supporting" });
    writePref("c", { topic: "x", principle: "core one", tier: "core" });
    const r = packContext(vault, { maxTokens: 10_000 });
    const ids = r.items.map((i) => i.id);
    expect(ids).toEqual(["pref-c", "pref-s", "pref-p"]);
  });

  test("within same tier, newest first by created_at", () => {
    writePref("old", {
      topic: "x",
      principle: "alpha",
      tier: "core",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("new", {
      topic: "x",
      principle: "beta",
      tier: "core",
      created_at: "2026-05-01T00:00:00Z",
    });
    const r = packContext(vault, { maxTokens: 10_000 });
    expect(r.items[0]!.id).toBe("pref-new");
    expect(r.items[1]!.id).toBe("pref-old");
  });

  test("stops when next page would exceed budget", () => {
    writePref("a", {
      topic: "x",
      principle: "alpha beta gamma delta epsilon",
      tier: "core",
      created_at: "2026-05-01T00:00:00Z",
    });
    writePref("b", {
      topic: "x",
      principle: "zeta eta theta iota kappa",
      tier: "core",
      created_at: "2026-04-01T00:00:00Z",
    });
    // budget of 30 fits one and at least partially trips the second
    const r = packContext(vault, { maxTokens: 30 });
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.tokensUsed).toBeLessThanOrEqual(30);
    // every dropped item is marked over-budget
    for (const s of r.skipped) {
      expect(s.reason).toBe("over-budget");
    }
  });

  test("query filters by normalised topic + principle", () => {
    writePref("match", {
      topic: "writing",
      principle: "Use imperative voice",
      tier: "core",
    });
    writePref("skip", {
      topic: "git",
      principle: "Squash before merge",
      tier: "core",
    });
    const r = packContext(vault, { maxTokens: 10_000, query: "imperative" });
    expect(r.items.map((i) => i.id)).toEqual(["pref-match"]);
    expect(r.skipped[0]!.reason).toBe("filter-miss");
  });

  test("query is case and Unicode insensitive", () => {
    writePref("ja", {
      topic: "テスト",
      principle: "Hello world",
      tier: "core",
    });
    const r = packContext(vault, { maxTokens: 10_000, query: "テスト" });
    expect(r.items.length).toBe(1);
  });

  test("non-positive maxTokens returns empty", () => {
    writePref("a", { topic: "x", principle: "alpha", tier: "core" });
    expect(packContext(vault, { maxTokens: 0 }).items.length).toBe(0);
    expect(packContext(vault, { maxTokens: -5 }).items.length).toBe(0);
  });
});
