/**
 * `brain_search` exposes a structured `score_breakdown` per result only
 * when the request sets `explain: true`. With the flag off the output is
 * byte-identical to the legacy shape (no score_breakdown key). Exercises
 * the tool through the same handler path the MCP server uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

const BREAKDOWN_KEYS = [
  "keyword",
  "semantic",
  "rrf",
  "entity",
  "activation",
  "coAccess",
  "link",
  "recency",
  "tier",
  "trend",
  "sessionFocus",
];

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-explain-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-explain-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "alpha.md"),
    "---\ntitle: Alpha\n---\n\nThe quick brown fox jumps over the lazy dog.\n",
  );
  ctx = { vault, configPath };
  const config = resolveSearchConfig({ vault, configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search explain", () => {
  const tool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

  test("no score_breakdown key when explain is absent", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool().handler(ctx as any, { query: "quick fox" })) as {
      results: Array<Record<string, unknown>>;
      total: number;
    };
    expect(out.total).toBeGreaterThan(0);
    for (const r of out.results) {
      expect("score_breakdown" in r).toBe(false);
    }
  });

  test("structured score_breakdown on every result when explain is true", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool().handler(ctx as any, { query: "quick fox", explain: true })) as {
      results: Array<{ score_breakdown?: Record<string, number> }>;
      total: number;
    };
    expect(out.total).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.score_breakdown).toBeDefined();
      for (const key of BREAKDOWN_KEYS) {
        expect(typeof r.score_breakdown![key]).toBe("number");
      }
      // keyword-only scratch vault: the bm25 lane carries the weight.
      expect(r.score_breakdown!.keyword).toBeGreaterThan(0);
    }
  });

  test("no trust key when trust is absent; structured trust when trust is true", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const off = (await tool().handler(ctx as any, { query: "quick fox" })) as {
      results: Array<Record<string, unknown>>;
    };
    for (const r of off.results) expect("trust" in r).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const on = (await tool().handler(ctx as any, { query: "quick fox", trust: true })) as {
      results: Array<{ trust?: { age_days: number; superseded: boolean; conflict: boolean } }>;
    };
    for (const r of on.results) {
      expect(r.trust).toBeDefined();
      expect(typeof r.trust!.age_days).toBe("number");
      expect(typeof r.trust!.superseded).toBe("boolean");
      expect(typeof r.trust!.conflict).toBe("boolean");
    }
  });
});
