/**
 * Shadow-only retrieval_plan advisor (R3, t_3ffb021c).
 *
 * A read-only module that composes the query plan (intent/weights/surface),
 * the context-pack density allocation, the token-impact ledger, and observed
 * route latency into a per-question retrieval plan. It emits source/query
 * strategy, token-budget allocation matching what the packer would spend,
 * graph-expansion advice, observed reliability with p95 latency, and a
 * marginal-value stop derived from the density curve plus p95 latency. It
 * exposes no mutating handles and changes no ranking or weight policy.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { buildRetrievalPlan } from "../../../src/core/brain/retrieval-plan.ts";
import type { ContextPackItem, ContextPackReport } from "../../../src/core/brain/context-pack.ts";
import type { TokenImpactSummary } from "../../../src/core/brain/token-impact.ts";
import type { McpRouteLatencySummary } from "../../../src/core/brain/mcp-route-metrics.ts";

function packItem(id: string, density: number, tokens: number): ContextPackItem {
  return {
    id,
    path: `${id}.md`,
    tier: "business",
    tokens,
    body: "body",
    principle: "p",
    contextLane: null,
    trimmed: false,
    epistemic: "observed",
    evidenceRefs: [],
    density,
  } as unknown as ContextPackItem;
}

function packReport(items: ContextPackItem[], budget: number): ContextPackReport {
  return {
    maxTokens: budget,
    tokensUsed: items.reduce((s, i) => s + i.tokens, 0),
    items,
    skipped: [],
  };
}

function tokenImpact(firstPassRate: number | null): TokenImpactSummary {
  return {
    total_samples: 3,
    prompt_token_delta: {
      total_samples: 3,
      net_savings_tokens: 100,
      saved_tokens: 100,
      added_tokens: 0,
      mean_savings_tokens: 33.3,
      by_method: {
        exact: { samples: 3, net_savings_tokens: 100 },
        fallback: { samples: 0, net_savings_tokens: 0 },
      },
    },
    modeled_inference_avoidance: {
      samples: 3,
      raw_savings_tokens: 300,
      calibration: {
        total_outcomes: 3,
        first_pass: 2,
        repair: 1,
        retry: 0,
        first_pass_rate: firstPassRate,
        mean_tokens_per_inference: 100,
      },
      calibrated_savings_tokens: firstPassRate === null ? null : 300 * firstPassRate,
    },
  };
}

function routeLatency(count: number, errors: number, p95: number): McpRouteLatencySummary {
  return {
    total: count,
    error_count: errors,
    by_status: { ok: count - errors, error: errors },
    routes:
      count === 0
        ? []
        : [
            {
              tool: "brain_search",
              count,
              error_count: errors,
              min_ms: 1,
              max_ms: p95,
              avg_ms: p95 / 2,
              p50_ms: p95 / 2,
              p95_ms: p95,
              p99_ms: p95,
            },
          ],
  };
}

const DENSITIES = [packItem("a", 0.5, 100), packItem("b", 0.3, 100), packItem("c", 0.1, 100)];

function planWith(question: string, p95: number, budget = 2000) {
  return buildRetrievalPlan("/tmp/does-not-matter", question, {
    tokenBudget: budget,
    surfaceVocabulary: new Set(["summary"]),
    pack: () => packReport(DENSITIES, budget),
    tokenImpact: () => tokenImpact(0.75),
    routeLatency: () => routeLatency(10, 1, p95),
  });
}

test("strategy composes query-plan intent, weights, and the summary surface", () => {
  const summary = planWith("kind:summary postgres", 0);
  expect(summary.strategy.surface).toBe("summary");
  const broad = planWith("how do i configure the deployment process for staging here", 0);
  expect(broad.strategy.intent).toBe("broad");
  expect(broad.strategy.surface).toBe("default");
  expect(broad.strategy.weights.semanticMul).toBeGreaterThanOrEqual(1);
});

test("allocation matches what the packer would spend (tokens + density curve)", () => {
  const plan = planWith("staging deploys", 0);
  expect(plan.allocation.tokenBudget).toBe(2000);
  expect(plan.allocation.tokensUsed).toBe(300);
  expect(plan.allocation.itemCount).toBe(3);
  expect(plan.allocation.densityCurve).toEqual([0.5, 0.3, 0.1]);
});

test("graph expansion is advised for exploratory intents, not exact lookups", () => {
  expect(
    planWith("how do i configure the deployment process for staging here", 0).graphExpansion
      .advised,
  ).toBe(true);
  expect(planWith('"exact phrase here"', 0).graphExpansion.advised).toBe(false);
});

test("reliability reports route success rate, p95 latency, and first-pass rate", () => {
  const plan = planWith("staging deploys", 250);
  expect(plan.reliability.routeSamples).toBe(10);
  expect(plan.reliability.successRate).toBeCloseTo(0.9, 5);
  expect(plan.reliability.p95LatencyMs).toBe(250);
  expect(plan.reliability.firstPassRate).toBe(0.75);
});

test("marginal-value stop tightens as p95 latency rises", () => {
  const cheap = planWith("staging deploys", 0);
  const costly = planWith("staging deploys", 8000);
  expect(cheap.marginalStop.stopRank).toBe(2);
  expect(cheap.marginalStop.stopTokens).toBe(200);
  expect(costly.marginalStop.stopRank).toBe(1);
  expect(costly.marginalStop.stopTokens).toBe(100);
  expect(costly.marginalStop.stopRank).toBeLessThanOrEqual(cheap.marginalStop.stopRank);
});

test("no route data yields null reliability without throwing", () => {
  const plan = buildRetrievalPlan("/tmp/x", "staging deploys", {
    pack: () => packReport(DENSITIES, 2000),
    tokenImpact: () => tokenImpact(null),
    routeLatency: () => routeLatency(0, 0, 0),
  });
  expect(plan.reliability.successRate).toBeNull();
  expect(plan.reliability.p95LatencyMs).toBeNull();
  expect(plan.reliability.firstPassRate).toBeNull();
});

// ----- shadow-only: real composition writes nothing --------------------------

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-retrieval-plan-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function listing(root: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push([relative(root, abs), statSync(abs).size]);
    }
  };
  walk(root);
  return out.toSorted((a, b) => a[0].localeCompare(b[0]));
}

test("the real composition is read-only (no config or store writes)", () => {
  const before = listing(vault);
  const plan = buildRetrievalPlan(vault, "how do i configure staging deploys", {
    tokenBudget: 1500,
  });
  expect(plan.question).toBe("how do i configure staging deploys");
  expect(plan.allocation.tokenBudget).toBe(1500);
  expect(listing(vault)).toEqual(before);
});
