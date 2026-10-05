/**
 * Semantic query mode on the context-pack lane (Honest Embedding Spend,
 * task 12).
 *
 * `ranked` orders by token overlap, so a paraphrase that shares no word
 * with the belief it means reads relevance 0 and falls to recency. The
 * `semantic` mode reads a relevance map the async boundary computed from
 * stored vectors, keyed by vault-relative path, in the same comparator
 * slot `ranked` uses. Pinned here:
 *   1. A zero-overlap paraphrase orders the closest belief first within
 *      its tier, and tier stays the coarse gate.
 *   2. `semantic.scored` and `semantic.unembedded` are computed after the
 *      reach filter, so a withheld page appears in neither, and its score
 *      cannot change the order.
 *   3. A `semantic` call without a map throws a named error instead of
 *      silently packing by recency.
 *   4. When no kept candidate is scored the pack refuses with
 *      `BELIEF_VECTORS_MISSING`, naming the scoped backfill, before any
 *      receipt is written; a withheld page with a vector cannot lift the
 *      refusal, and an empty candidate set is an empty pack.
 *   5. `substring` and `ranked` carry no `semantic` report.
 *
 * Not covered: how the map is built (belief-semantic.test.ts) and the
 * MCP refusal when nothing kept is scored (context-pack-tool.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BELIEF_VECTORS_BACKFILL_COMMAND,
  ContextPackSemanticRelevanceMissingError,
  packContext,
} from "../../../src/core/brain/context-pack.ts";
import { listContextReceipts } from "../../../src/core/brain/context-receipts.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";

let vault: string;

/** Shares no token with any principle below. */
const PARAPHRASE = "how terse should my replies be";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-c12-pack-semantic-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(
  slug: string,
  fields: { principle: string; tier?: string; created_at: string },
): void {
  const lines = ["---", `id: pref-${slug}`, `topic: ${slug}`, `principle: ${fields.principle}`];
  if (fields.tier) lines.push(`tier: ${fields.tier}`);
  lines.push(`created_at: ${fields.created_at}`, "---", "", fields.principle);
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"));
}

function rel(slug: string): string {
  return `Brain/preferences/pref-${slug}.md`;
}

function writeBeliefs(): void {
  writePref("brevity", {
    principle: "keep answers short",
    tier: "core",
    created_at: "2026-01-01T00:00:00Z",
  });
  writePref("deploy", {
    principle: "never ship on friday",
    tier: "core",
    created_at: "2026-01-03T00:00:00Z",
  });
  writePref("imports", {
    principle: "use explicit imports only",
    tier: "core",
    created_at: "2026-01-02T00:00:00Z",
  });
  writePref("tabs", {
    principle: "indent makefiles with tabs",
    tier: "peripheral",
    created_at: "2026-01-04T00:00:00Z",
  });
}

const RELEVANCE: ReadonlyMap<string, number> = new Map([
  [rel("brevity"), 0.92],
  [rel("deploy"), 0.11],
  [rel("tabs"), 0.99],
]);

describe("packContext semantic mode", () => {
  test("a zero-overlap paraphrase orders the closest belief first within its tier", () => {
    writeBeliefs();
    const ranked = packContext(vault, {
      maxTokens: 10_000,
      query: PARAPHRASE,
      queryMode: "ranked",
    });
    expect(ranked.items[0]!.id).toBe("pref-deploy");

    const report = packContext(vault, {
      maxTokens: 10_000,
      query: PARAPHRASE,
      queryMode: "semantic",
      semanticRelevance: RELEVANCE,
    });
    expect(report.items.map((i) => i.id)).toEqual([
      "pref-brevity",
      "pref-deploy",
      "pref-imports",
      "pref-tabs",
    ]);
    expect(report.skipped).toEqual([]);
    expect(report.semantic).toEqual({ scored: 3, unembedded: ["pref-imports"] });
  });

  test("a scored belief with a negative cosine still ranks above an unembedded one", () => {
    writePref("brevity", {
      principle: "keep answers short",
      tier: "core",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("imports", {
      principle: "use explicit imports only",
      tier: "core",
      created_at: "2026-01-02T00:00:00Z",
    });
    const report = packContext(vault, {
      maxTokens: 10_000,
      query: PARAPHRASE,
      queryMode: "semantic",
      semanticRelevance: new Map([[rel("brevity"), -0.4]]),
    });
    expect(report.items.map((i) => i.id)).toEqual(["pref-brevity", "pref-imports"]);
    expect(report.semantic).toEqual({ scored: 1, unembedded: ["pref-imports"] });
  });

  test("unembedded is sorted by id even where recency orders the items the other way", () => {
    writePref("brevity", {
      principle: "keep answers short",
      tier: "core",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("alpha", {
      principle: "the oldest",
      tier: "core",
      created_at: "2026-01-02T00:00:00Z",
    });
    writePref("zeta", {
      principle: "the newest",
      tier: "core",
      created_at: "2026-01-09T00:00:00Z",
    });
    const report = packContext(vault, {
      maxTokens: 10_000,
      query: PARAPHRASE,
      queryMode: "semantic",
      semanticRelevance: new Map([[rel("brevity"), 0.5]]),
    });
    expect(report.items.map((i) => i.id)).toEqual(["pref-brevity", "pref-zeta", "pref-alpha"]);
    expect(report.semantic).toEqual({ scored: 1, unembedded: ["pref-alpha", "pref-zeta"] });
  });

  test("scored and unembedded are computed after the reach filter", () => {
    writeBeliefs();
    const withheld = join(vault, rel("brevity"));
    const report = packContext(vault, {
      maxTokens: 10_000,
      query: PARAPHRASE,
      queryMode: "semantic",
      semanticRelevance: RELEVANCE,
      visible: (abs) => abs !== withheld,
    });
    expect(report.items.map((i) => i.id)).toEqual(["pref-deploy", "pref-imports", "pref-tabs"]);
    expect(report.semantic).toEqual({ scored: 2, unembedded: ["pref-imports"] });

    const hiddenUnembedded = packContext(vault, {
      maxTokens: 10_000,
      query: PARAPHRASE,
      queryMode: "semantic",
      semanticRelevance: RELEVANCE,
      visible: (abs) => abs !== join(vault, rel("imports")),
    });
    expect(hiddenUnembedded.semantic).toEqual({ scored: 3, unembedded: [] });
  });

  test("a semantic call without a relevance map throws a named error", () => {
    writeBeliefs();
    expect(() =>
      packContext(vault, { maxTokens: 10_000, query: PARAPHRASE, queryMode: "semantic" }),
    ).toThrow(ContextPackSemanticRelevanceMissingError);
  });

  test("no scored kept candidate refuses by name before any receipt is written", () => {
    writeBeliefs();
    const onlyBrevityVisible = join(vault, rel("brevity"));
    const refusal = (() => {
      try {
        packContext(vault, {
          maxTokens: 10_000,
          query: PARAPHRASE,
          queryMode: "semantic",
          semanticRelevance: new Map([[rel("deploy"), 0.5]]),
          visible: (abs) => abs === onlyBrevityVisible,
          receipt: { trigger: "context_pack", host: "test" },
        });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("BELIEF_VECTORS_MISSING");
    expect((refusal as SearchError).message).toContain(BELIEF_VECTORS_BACKFILL_COMMAND);
    expect(BELIEF_VECTORS_BACKFILL_COMMAND).toBe(
      "o2b search vector-backfill --path Brain/preferences/ --path Brain/retired/ --apply",
    );
    expect(listContextReceipts(vault, {})).toEqual([]);

    // Control: the same call with the scored page in reach does write one.
    packContext(vault, {
      maxTokens: 10_000,
      query: PARAPHRASE,
      queryMode: "semantic",
      semanticRelevance: new Map([[rel("deploy"), 0.5]]),
      receipt: { trigger: "context_pack", host: "test" },
    });
    expect(listContextReceipts(vault, {}).length).toBe(1);
  });

  test("an empty candidate set is an empty pack, not a refusal", () => {
    const report = packContext(vault, {
      maxTokens: 10_000,
      query: PARAPHRASE,
      queryMode: "semantic",
      semanticRelevance: new Map(),
    });
    expect(report.items).toEqual([]);
    expect(report.semantic).toEqual({ scored: 0, unembedded: [] });
  });

  test("substring and ranked carry no semantic report", () => {
    writeBeliefs();
    for (const queryMode of ["substring", "ranked"] as const) {
      const report = packContext(vault, { maxTokens: 10_000, query: "short", queryMode });
      expect("semantic" in report).toBe(false);
    }
  });
});
