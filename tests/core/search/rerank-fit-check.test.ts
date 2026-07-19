/**
 * Per-store reranker fit check diagnostic (R2, t_267f3b4c).
 *
 * Samples real recorded queries, computes the correlation between the
 * reranker's scores and the base retrieval signal, and reports out-of-domain
 * (low fit) and inverted (negative correlation) verdicts with a concrete
 * recommendation. Quiet when the reranker helps; rerankerless vaults report
 * inapplicable. Strictly read-only: the integration test asserts no config
 * or store writes.
 */

import { test, expect } from "bun:test";
import { statSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  rerankFitCheck,
  type RerankFitCandidateSet,
} from "../../../src/core/search/rerank-fit-check.ts";
import type { RerankProvider } from "../../../src/core/search/rerank/contract.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { recordQueryDemand } from "../../../src/core/brain/query-demand.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

/** A provider that returns preset scores per query, ignoring documents. */
function fixedProvider(scoresByQuery: Record<string, ReadonlyArray<number>>): RerankProvider {
  return {
    name: "test-fixed",
    model: "test",
    rerank: (query, documents) => {
      const scores = scoresByQuery[query] ?? [];
      return Promise.resolve(documents.map((_, i) => scores[i] ?? 0));
    },
  };
}

/** Base candidates with descending base scores, matching rank order. */
function candidates(query: string, n: number): RerankFitCandidateSet {
  return {
    query,
    documents: Array.from({ length: n }, (_, i) => `doc-${i}`),
    baseScores: Array.from({ length: n }, (_, i) => 1 - i * 0.2),
  };
}

const RERANK_ON = { rerank: { enabled: true, kind: "local" as const } };

test("a disabled reranker reports the diagnostic as inapplicable", async () => {
  const { vault, dbPath, cleanup } = createTempVault("fit-off");
  try {
    const report = await rerankFitCheck(makeConfig({ vault, dbPath }), {
      queries: ["alpha beta"],
      fetchCandidates: (q) => Promise.resolve(candidates(q, 4)),
      provider: fixedProvider({ "alpha beta": [4, 3, 2, 1] }),
    });
    expect(report.applicable).toBe(false);
    expect(report.verdict).toBe("inapplicable");
    expect(report.reason.toLowerCase()).toContain("disabled");
  } finally {
    cleanup();
  }
});

test("no recorded queries reports inapplicable", async () => {
  const { vault, dbPath, cleanup } = createTempVault("fit-nodata");
  try {
    const report = await rerankFitCheck(makeConfig({ vault, dbPath, ...RERANK_ON }), {
      queries: [],
      fetchCandidates: (q) => Promise.resolve(candidates(q, 4)),
      provider: fixedProvider({}),
    });
    expect(report.applicable).toBe(false);
    expect(report.verdict).toBe("inapplicable");
  } finally {
    cleanup();
  }
});

test("a reranker anti-correlated with the base signal is inverted (recommend disable)", async () => {
  const { vault, dbPath, cleanup } = createTempVault("fit-inv");
  try {
    const report = await rerankFitCheck(makeConfig({ vault, dbPath, ...RERANK_ON }), {
      queries: ["alpha beta"],
      fetchCandidates: (q) => Promise.resolve(candidates(q, 4)),
      // base ranks 4,3,2,1; rerank 1,2,3,4 -> Spearman -1
      provider: fixedProvider({ "alpha beta": [1, 2, 3, 4] }),
    });
    expect(report.applicable).toBe(true);
    expect(report.verdict).toBe("inverted");
    expect(report.correlation).toBeLessThan(0);
    expect(report.recommendation.toLowerCase()).toContain("disable");
  } finally {
    cleanup();
  }
});

test("a reranker uncorrelated with the base signal is out-of-domain (recommend swap/disable)", async () => {
  const { vault, dbPath, cleanup } = createTempVault("fit-ood");
  try {
    const report = await rerankFitCheck(makeConfig({ vault, dbPath, ...RERANK_ON }), {
      queries: ["alpha beta"],
      fetchCandidates: (q) => Promise.resolve(candidates(q, 4)),
      // base ranks 4,3,2,1; rerank 2,4,1,3 -> Spearman 0
      provider: fixedProvider({ "alpha beta": [2, 4, 1, 3] }),
    });
    expect(report.applicable).toBe(true);
    expect(report.verdict).toBe("out_of_domain");
    expect(Math.abs(report.correlation ?? 1)).toBeLessThan(0.15);
    expect(report.recommendation.toLowerCase()).toMatch(/swap|disable/);
  } finally {
    cleanup();
  }
});

test("a reranker that tracks the base signal fits and stays quiet", async () => {
  const { vault, dbPath, cleanup } = createTempVault("fit-ok");
  try {
    const report = await rerankFitCheck(makeConfig({ vault, dbPath, ...RERANK_ON }), {
      queries: ["alpha beta"],
      fetchCandidates: (q) => Promise.resolve(candidates(q, 4)),
      provider: fixedProvider({ "alpha beta": [4, 3, 2, 1] }),
    });
    expect(report.applicable).toBe(true);
    expect(report.verdict).toBe("fits");
    expect(report.correlation).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test("integration: local reranker over a real index is read-only (no config/store writes)", async () => {
  const { vault, dbPath, cleanup } = createTempVault("fit-integration");
  try {
    writeMd(vault, "a.md", "# Alpha\n\nAlpha beta gamma delta about postgres backups.\n");
    writeMd(vault, "b.md", "# Beta\n\nAlpha beta gamma staging deploy pipelines here.\n");
    writeMd(vault, "c.md", "# Gamma\n\nAlpha beta gamma configure the database schema.\n");
    const cfg = makeConfig({ vault, dbPath, ...RERANK_ON });
    await indexVault(cfg);
    recordQueryDemand(vault, { query: "alpha beta gamma", resultCount: 2 });
    recordQueryDemand(vault, { query: "alpha beta gamma", resultCount: 2 });

    // Read-only proof: no bytes written to the store (size stable, no new
    // sidecar files) and the demand log content is untouched. A cache row,
    // index rebuild, or access record would grow the store; mtime is not
    // asserted because a read-mode open can touch it without writing data.
    const storeDir = dirname(dbPath);
    const dbBefore = statSync(dbPath).size;
    const filesBefore = readdirSync(storeDir).toSorted();
    const demandPath = join(vault, "Brain", "log", "query-demand.jsonl");
    const demandBefore = readFileSync(demandPath, "utf8");

    const report = await rerankFitCheck(cfg, {});
    expect(report.applicable).toBe(true);
    expect(["fits", "out_of_domain", "inverted"]).toContain(report.verdict);

    expect(statSync(dbPath).size).toBe(dbBefore);
    expect(readdirSync(storeDir).toSorted()).toEqual(filesBefore);
    expect(readFileSync(demandPath, "utf8")).toBe(demandBefore);
  } finally {
    cleanup();
  }
});
