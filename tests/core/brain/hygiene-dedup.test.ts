/**
 * Semantic dedup detector layer
 * (continuity-hygiene-freshness suite, Task 9; kanban t_da3f138f).
 *
 * Embedding cosine similarity above the threshold (default 0.97)
 * nominates near-duplicate preferences for merge, across topic
 * buckets. When no usable embedding provider exists (or it fails),
 * the detector falls back to the deterministic lexical layer and the
 * report says so - lexical similarity is never passed off as
 * semantic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { EmbeddingProvider } from "../../../src/core/search/embeddings/contract.ts";
import { detectSemanticDedup } from "../../../src/core/brain/hygiene/detectors/dedup.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-dedup-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, topic: string, principle: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      `topic: ${topic}`,
      "_status: confirmed",
      `principle: ${principle}`,
      "created_at: 2026-01-01T00:00:00Z",
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

function fixedVectorProvider(vectors: Readonly<Record<string, number[]>>): EmbeddingProvider {
  return {
    name: "fixed",
    model: "fixed-test",
    dimension: 3,
    embed: (texts) => Promise.resolve(texts.map((text) => vectors[text] ?? [0, 0, 1])),
    ping: () => Promise.resolve({ ok: true as const, dimension: 3 }),
  };
}

describe("detectSemanticDedup", () => {
  test("reports embedding pairs above the threshold across topic buckets", async () => {
    writePref("a", "writing-style", "Never use exclamation marks in docs");
    writePref("b", "doc-tone", "Do not use exclamation marks in documentation");
    writePref("c", "git", "Always rebase before merge");
    const provider = fixedVectorProvider({
      "Never use exclamation marks in docs": [1, 0, 0],
      "Do not use exclamation marks in documentation": [0.999, 0.0447, 0],
      "Always rebase before merge": [0, 1, 0],
    });
    const result = await detectSemanticDedup(vault, { provider });
    expect(result.method).toBe("embedding");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.targets).toEqual(["pref-a", "pref-b"]);
    expect(finding.proposed_action).toBe("merge");
    expect(finding.evidence["method"]).toBe("embedding");
    expect(finding.evidence["model"]).toBe("fixed-test");
  });

  test("falls back to the lexical layer when the provider fails", async () => {
    writePref("x", "same-topic", "Collect the metrics before optimizing the code");
    writePref("y", "same-topic", "Collect the metrics before optimizing the code base");
    const broken: EmbeddingProvider = {
      name: "broken",
      model: "broken",
      dimension: 3,
      embed: () => Promise.reject(new Error("provider down")),
      ping: () => Promise.resolve({ ok: false as const, reason: "down" }),
    };
    const result = await detectSemanticDedup(vault, { provider: broken });
    expect(result.method).toBe("lexical");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.evidence["method"]).toBe("lexical");
  });

  test("falls back to lexical when no provider is usable", async () => {
    const result = await detectSemanticDedup(vault, { provider: null });
    expect(result.method).toBe("lexical");
    expect(result.findings).toHaveLength(0);
  });
});
