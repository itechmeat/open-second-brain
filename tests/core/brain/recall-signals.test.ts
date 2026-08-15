/**
 * Recall-quality signals on the per-query telemetry record
 * (what-the-index-already-knew, task G).
 *
 * Four signals are derived from values the retrieval pipeline ALREADY
 * computed and then discarded: the fused and per-lane scores
 * (alignment), the opt-in trust metadata, the typed `contradicts` edges
 * surfaced on the row, and the deterministic token-set overlap of the
 * surfaced pool (diversity). Nothing here reads a file, a clock, or an
 * embedding.
 *
 * The two signals the wave refused - named in
 * `docs/brainstorm/what-the-index-already-knew/design.md` under "Out of
 * scope" - are asserted absent from `src/` by the census at the bottom,
 * which proves it can fail against an injected fixture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveRecallSignals,
  emitRecallTelemetry,
  RECALL_SIGNALS_DIVERSITY_MAX_ROWS,
  RECALL_SIGNALS_UNMEASURED_CARDS,
  RECALL_CHANNEL,
} from "../../../src/core/brain/recall-telemetry.ts";
import { clipPayloadToBudget } from "../../../src/core/brain/continuity/store.ts";
import type { BrainSearchResult } from "../../../src/core/search/search-result.ts";

const CREATED_AT = "2026-08-07T12:00:00.000Z";

function row(over: Partial<BrainSearchResult> & { readonly content: string }): BrainSearchResult {
  return {
    documentId: 1,
    chunkId: 1,
    path: "notes/a.md",
    title: "A",
    startLine: 1,
    endLine: 4,
    score: 0.5,
    keywordScore: 0.3,
    semanticScore: 0.2,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "hybrid",
    reasons: ["keyword: 0.30"],
    ...over,
  };
}

describe("deriveRecallSignals", () => {
  test("an empty pool has nothing to measure and returns null", () => {
    expect(deriveRecallSignals([])).toBeNull();
  });

  test("alignment reports the already-computed fused and per-lane scores", () => {
    const signals = deriveRecallSignals([
      row({ content: "alpha beta gamma", score: 0.8, keywordScore: 0.5, semanticScore: 0.3 }),
      row({ content: "delta epsilon zeta", score: 0.5, keywordScore: 0.2, semanticScore: 0.3 }),
    ])!;

    expect(signals.rows).toBe(2);
    expect(signals.alignment).toEqual({
      top: 0.8,
      mean: 0.65,
      margin: 0.3,
      keyword_sum: 0.7,
      semantic_sum: 0.6,
    });
  });

  test("a single-row pool omits the margin instead of reporting a fabricated zero", () => {
    const signals = deriveRecallSignals([row({ content: "alpha" })])!;
    expect("margin" in signals.alignment).toBe(false);
  });

  test("trust counts only the rows that actually carry trust metadata", () => {
    const untrusted = deriveRecallSignals([row({ content: "alpha" })])!;
    expect(untrusted.trust).toEqual({ assessed: 0, superseded: 0, conflict: 0 });

    const trusted = deriveRecallSignals([
      row({
        content: "alpha",
        trust: { age_days: 12, superseded: true, conflict: false, replacement: "notes/b.md" },
      }),
      row({
        content: "beta",
        trust: { age_days: 3, superseded: false, conflict: true, replacement: null },
      }),
    ])!;
    expect(trusted.trust).toEqual({
      assessed: 2,
      superseded: 1,
      conflict: 1,
      max_age_days: 12,
    });
  });

  test("contradiction counts typed edges without the trust opt-in", () => {
    const signals = deriveRecallSignals([
      row({
        content: "alpha",
        relations: [
          { relation: "contradicts", target: "notes/b.md" },
          { relation: "contradicts", target: "notes/c.md" },
          { relation: "related", target: "notes/d.md" },
        ],
      }),
      row({ content: "beta", relations: [{ relation: "related", target: "notes/e.md" }] }),
    ])!;

    expect(signals.contradiction).toEqual({ rows: 1, edges: 2 });
  });

  test("diversity is a pool-level token overlap, similarity absent when there is no pair", () => {
    const identical = deriveRecallSignals([
      row({ content: "alpha beta gamma" }),
      row({ content: "alpha beta gamma" }),
    ])!;
    expect(identical.diversity).toEqual({
      compared: 2,
      pairs: 1,
      mean_similarity: 1,
      max_similarity: 1,
    });

    const disjoint = deriveRecallSignals([
      row({ content: "alpha beta gamma" }),
      row({ content: "delta epsilon zeta" }),
    ])!;
    expect(disjoint.diversity.mean_similarity).toBe(0);
    expect(disjoint.diversity.max_similarity).toBe(0);

    const single = deriveRecallSignals([row({ content: "alpha beta" })])!;
    expect(single.diversity).toEqual({ compared: 1, pairs: 0 });
  });

  test("the pairwise walk is bounded, and the record names the bound it used", () => {
    const many = Array.from({ length: RECALL_SIGNALS_DIVERSITY_MAX_ROWS + 5 }, () =>
      row({ content: "alpha beta gamma" }),
    );
    const signals = deriveRecallSignals(many)!;

    expect(signals.rows).toBe(RECALL_SIGNALS_DIVERSITY_MAX_ROWS + 5);
    expect(signals.diversity.compared).toBe(RECALL_SIGNALS_DIVERSITY_MAX_ROWS);
    const k = RECALL_SIGNALS_DIVERSITY_MAX_ROWS;
    expect(signals.diversity.pairs).toBe((k * (k - 1)) / 2);
  });

  test("the derivation never mutates or reorders the pool it reads", () => {
    const rows = Object.freeze([
      row({ content: "alpha", score: 0.1 }),
      row({ content: "beta", score: 0.9 }),
    ]);
    const before = JSON.stringify(rows);
    deriveRecallSignals(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("recall telemetry record", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-recall-signals-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  const base = {
    createdAt: CREATED_AT,
    host: "unit",
    channel: RECALL_CHANNEL.cli,
    mode: "search" as const,
    status: "ok" as const,
    durationMs: 4,
    resultCount: 1,
  };

  test("byte identity: without signals the payload is unchanged, key absent and not null", () => {
    const record = emitRecallTelemetry(vault, base);

    expect(JSON.stringify(record.payload)).toBe(
      '{"host":"unit","channel":"cli","mode":"search","status":"ok","duration_ms":4,"result_count":1,' +
        '"top_artifacts":[],"gaps":[]}',
    );
    expect("signals" in record.payload).toBe(false);
  });

  test("signals ride inside the single per-query record when supplied", () => {
    const signals = deriveRecallSignals([
      row({ content: "alpha beta" }),
      row({ content: "alpha gamma" }),
    ])!;
    const record = emitRecallTelemetry(vault, { ...base, signals });

    expect(record.payload["signals"]).toEqual(signals);
    // Every signal is a number, so the redactor has no string to rewrite:
    // the block survives the sanitiser byte-identically.
    expect(record.redacted).toBe(false);
    expect(record.private).toBe(false);
  });

  test("the cards surface records why it could not measure rather than going quiet", () => {
    const record = emitRecallTelemetry(vault, {
      ...base,
      signals: RECALL_SIGNALS_UNMEASURED_CARDS,
    });

    expect(record.payload["signals"]).toEqual({ unmeasured: "disclosure_cards" });
    expect(record.redacted).toBe(false);
  });

  test("under the shared clip budget the signals block drops whole, identity survives", () => {
    const signals = deriveRecallSignals([
      row({ content: "alpha beta" }),
      row({ content: "alpha gamma" }),
    ])!;
    const record = emitRecallTelemetry(vault, {
      ...base,
      sessionId: "sess-1",
      signals,
    });

    const full = JSON.stringify(record.payload).length;
    const clipped = clipPayloadToBudget(record.payload, full - 1);
    expect("signals" in clipped).toBe(false);
    expect(clipped["session_id"]).toBe("sess-1");
  });
});

/**
 * The two refused signals must not exist in the shipped source. The scan
 * is proved able to fail by running the same matcher over an injected
 * violating fixture.
 */
describe("refused recall signals census", () => {
  const REFUSED: ReadonlyArray<string> = [
    "acquisition_risk",
    "acquisitionRisk",
    "expected_regret",
    "expectedRegret",
  ];

  function violations(text: string): ReadonlyArray<string> {
    return REFUSED.filter((name) => text.includes(name));
  }

  /**
   * The population this census is only as good as. A glob that matched
   * nothing would report a clean sweep over an empty set, which is the
   * failure mode this whole wave is about, so the walk states its own
   * size before it states its verdict.
   */
  const MIN_SCANNED_SOURCES = 700;

  test("no shipped source file names a refused signal", () => {
    const root = join(import.meta.dir, "..", "..", "..", "src");
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: root, absolute: true })) {
      scanned++;
      const found = violations(readFileSync(file, "utf8"));
      if (found.length > 0) offenders.push(`${file}: ${found.join(", ")}`);
    }
    // Non-vacuity first: a narrowed pattern or a moved tree makes the
    // sweep below meaningless, and it would pass.
    expect(`scanned ${scanned >= MIN_SCANNED_SOURCES}`).toBe("scanned true");
    // And the walk really reaches the module the signals live in, so a
    // count alone cannot stand in for coverage of the relevant tree.
    expect(
      offenders.length === 0 && existsSync(join(root, "core", "brain", "recall-telemetry.ts")),
    ).toBe(true);
    expect(offenders).toEqual([]);
  });

  test("the census can fail: an injected violating fixture is caught", () => {
    expect(violations("const acquisition_risk = 0.5;")).toEqual(["acquisition_risk"]);
    expect(violations("const expectedRegret = 0.5;")).toEqual(["expectedRegret"]);
  });
});
