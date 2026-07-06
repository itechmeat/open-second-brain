import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { queryDemandLogPath } from "../../../src/core/brain/paths.ts";
import {
  DEMAND_LOG_MAX_BYTES,
  aggregateQueryDemand,
  normalizeQueryTerms,
  readQueryDemand,
  recordQueryDemand,
} from "../../../src/core/brain/query-demand.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-query-demand-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("normalizeQueryTerms", () => {
  test("keeps significant terms, sorts, dedupes, drops short tokens", () => {
    expect(normalizeQueryTerms("How does the AUTH flow work flow")).toEqual([
      "auth",
      "does",
      "flow",
      "how",
      "the",
      "work",
    ]);
  });

  test("drops secret-shaped tokens the redactor rewrites", () => {
    const terms = normalizeQueryTerms("api key sk-abcdef0123456789abcdef0123456789 rotation");
    expect(terms).toContain("api");
    expect(terms).toContain("key");
    expect(terms).toContain("rotation");
    expect(terms.some((t) => t.includes("sk-abcdef"))).toBe(false);
    expect(terms.some((t) => t.includes("REDACTED"))).toBe(false);
  });

  test("empty when no significant terms", () => {
    expect(normalizeQueryTerms("a it")).toEqual([]);
  });
});

describe("recordQueryDemand", () => {
  test("appends a normalized record and never stores the raw query", () => {
    const record = recordQueryDemand(vault, {
      query: "deployment rollback procedure",
      resultCount: 0,
      coverage: 0.1,
      at: "2026-07-01T10:00:00.000Z",
    });
    expect(record).not.toBeNull();
    expect(record!.terms).toEqual(["deployment", "procedure", "rollback"]);
    expect(record!.results).toBe(0);
    expect(record!.coverage).toBe(0.1);

    const raw = readFileSync(queryDemandLogPath(vault), "utf8");
    expect(raw).not.toContain("deployment rollback procedure");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  test("omits coverage when not provided", () => {
    const record = recordQueryDemand(vault, { query: "orphaned notes cleanup", resultCount: 3 });
    expect(record!.coverage).toBeUndefined();
  });

  test("does not record a query with no significant terms", () => {
    const record = recordQueryDemand(vault, { query: "a of to", resultCount: 5 });
    expect(record).toBeNull();
    expect(existsSync(queryDemandLogPath(vault))).toBe(false);
  });

  test("clamps out-of-range coverage and negative result counts", () => {
    const r = recordQueryDemand(vault, {
      terms: ["alpha"],
      resultCount: -4,
      coverage: 1.7,
      at: "2026-07-01T10:00:00.000Z",
    });
    expect(r!.results).toBe(0);
    expect(r!.coverage).toBe(1);
  });
});

describe("readQueryDemand", () => {
  test("filters by since/until and sorts by timestamp", () => {
    recordQueryDemand(vault, { terms: ["aaa"], resultCount: 1, at: "2026-07-03T00:00:00.000Z" });
    recordQueryDemand(vault, { terms: ["bbb"], resultCount: 1, at: "2026-07-01T00:00:00.000Z" });
    recordQueryDemand(vault, { terms: ["ccc"], resultCount: 1, at: "2026-07-02T00:00:00.000Z" });

    const all = readQueryDemand(vault);
    expect(all.map((r) => r.ts)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ]);

    const windowed = readQueryDemand(vault, {
      since: "2026-07-02T00:00:00.000Z",
      until: "2026-07-02T23:59:59.000Z",
    });
    expect(windowed.map((r) => r.terms[0])).toEqual(["ccc"]);
  });

  test("empty when the log does not exist", () => {
    expect(readQueryDemand(vault)).toEqual([]);
  });

  test("second-precision since/until bounds compare consistently against ms records", () => {
    // Records are stored at millisecond precision. A raw lexical compare
    // against a second-precision bound misfires because `.` (0x2E) sorts
    // before `Z` (0x5A): `since 00:00:00Z` wrongly DROPS the whole
    // [.000, .999] window, and `until 00:00:00Z` wrongly KEEPS it.
    recordQueryDemand(vault, { terms: ["before"], resultCount: 1, at: "2026-06-30T23:59:59.500Z" });
    recordQueryDemand(vault, {
      terms: ["lowedge"],
      resultCount: 1,
      at: "2026-07-01T00:00:00.000Z",
    });
    recordQueryDemand(vault, { terms: ["midlow"], resultCount: 1, at: "2026-07-01T00:00:00.500Z" });
    recordQueryDemand(vault, {
      terms: ["highedge"],
      resultCount: 1,
      at: "2026-07-01T00:00:00.999Z",
    });
    recordQueryDemand(vault, { terms: ["after"], resultCount: 1, at: "2026-07-01T00:00:01.000Z" });

    // `since 00:00:00Z` (normalized to .000Z) keeps the whole second and the
    // record after it; the pre-fix lexical compare dropped lowedge/midlow/
    // highedge because `.NNNZ` < `Z`.
    const fromSecond = readQueryDemand(vault, { since: "2026-07-01T00:00:00Z" });
    expect(fromSecond.map((r) => r.terms[0])).toEqual(["lowedge", "midlow", "highedge", "after"]);

    // `until 00:00:00Z` (normalized to .000Z) is inclusive of exactly .000Z
    // and excludes the rest of the second; the pre-fix lexical compare
    // wrongly kept midlow/highedge (`.NNNZ` < `Z` ⇒ not `> until`).
    const untilSecond = readQueryDemand(vault, { until: "2026-07-01T00:00:00Z" });
    expect(untilSecond.map((r) => r.terms[0])).toEqual(["before", "lowedge"]);
  });
});

describe("aggregateQueryDemand", () => {
  test("buckets recurring poorly-answered queries and ranks by demand", () => {
    // "vault backups" asked 3x, always weak coverage -> high demand.
    for (let i = 0; i < 3; i++) {
      recordQueryDemand(vault, {
        query: "vault backups schedule",
        resultCount: 0,
        coverage: 0.05,
        at: `2026-07-0${i + 1}T00:00:00.000Z`,
      });
    }
    // "release process" asked 2x, well covered -> excluded by default.
    for (let i = 0; i < 2; i++) {
      recordQueryDemand(vault, {
        query: "release process steps",
        resultCount: 5,
        coverage: 0.95,
        at: `2026-07-0${i + 1}T01:00:00.000Z`,
      });
    }
    // "token budget" asked once -> below minOccurrences.
    recordQueryDemand(vault, {
      query: "token budget tuning",
      resultCount: 1,
      coverage: 0.2,
      at: "2026-07-01T02:00:00.000Z",
    });

    const report = aggregateQueryDemand(vault);
    expect(report.totalRecords).toBe(6);
    expect(report.distinctQueries).toBe(3);
    expect(report.gaps).toHaveLength(1);

    const gap = report.gaps[0]!;
    expect(gap.terms).toEqual(["backups", "schedule", "vault"]);
    expect(gap.occurrences).toBe(3);
    expect(gap.meanCoverage).toBeCloseTo(0.05, 5);
    expect(gap.emptyCount).toBe(3);
    expect(gap.emptyRate).toBe(1);
    expect(gap.coverageKnown).toBe(true);
    expect(gap.verdict).toBe("sparse");
    expect(gap.demandScore).toBeCloseTo(3 * (1 - 0.05), 4);
    expect(gap.firstSeen).toBe("2026-07-01T00:00:00.000Z");
    expect(gap.lastSeen).toBe("2026-07-03T00:00:00.000Z");
  });

  test("falls back to result-presence when no coverage was recorded", () => {
    recordQueryDemand(vault, { query: "cron secrets", resultCount: 0, at: "2026-07-01T00:00:00Z" });
    recordQueryDemand(vault, { query: "cron secrets", resultCount: 0, at: "2026-07-02T00:00:00Z" });

    const report = aggregateQueryDemand(vault);
    expect(report.gaps).toHaveLength(1);
    const gap = report.gaps[0]!;
    expect(gap.coverageKnown).toBe(false);
    expect(gap.meanCoverage).toBeNull();
    expect(gap.satisfaction).toBe(0);
    expect(gap.demandScore).toBe(2);
  });

  test("honors minOccurrences, maxSatisfaction, and limit", () => {
    for (let i = 0; i < 4; i++) {
      recordQueryDemand(vault, {
        query: "graph traversal depth",
        resultCount: 2,
        coverage: 0.5,
        at: `2026-07-0${i + 1}T00:00:00.000Z`,
      });
    }
    // Excluded when maxSatisfaction is stricter than 0.5.
    expect(aggregateQueryDemand(vault, { maxSatisfaction: 0.4 }).gaps).toHaveLength(0);
    // Included at the default 0.8 ceiling.
    expect(aggregateQueryDemand(vault, { maxSatisfaction: 0.8 }).gaps).toHaveLength(1);
    // Excluded when minOccurrences exceeds the count.
    expect(aggregateQueryDemand(vault, { minOccurrences: 5 }).gaps).toHaveLength(0);

    for (let i = 0; i < 3; i++) {
      recordQueryDemand(vault, {
        query: "another weak query",
        resultCount: 0,
        coverage: 0.0,
        at: `2026-07-0${i + 1}T03:00:00.000Z`,
      });
    }
    const limited = aggregateQueryDemand(vault, { limit: 1 });
    expect(limited.gaps).toHaveLength(1);
    // The zero-coverage query outranks the 0.5-coverage one.
    expect(limited.gaps[0]!.terms).toEqual(["another", "query", "weak"]);
  });
});

describe("rolling cap", () => {
  test("compacts the log once it exceeds the byte budget", () => {
    const path = queryDemandLogPath(vault);
    // Each record ~ small; write enough to blow past the 1MB cap.
    const terms = ["compaction", "stress", "budget"];
    for (let i = 0; i < 20_000; i++) {
      recordQueryDemand(vault, {
        terms,
        resultCount: 0,
        coverage: 0.1,
        at: "2026-07-01T00:00:00.000Z",
      });
    }
    const size = statSync(path).size;
    expect(size).toBeLessThanOrEqual(DEMAND_LOG_MAX_BYTES);
    // Compaction keeps recent lines readable and parseable.
    const records = readQueryDemand(vault);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.terms.join(" ") === "budget compaction stress")).toBe(true);
  });
});
