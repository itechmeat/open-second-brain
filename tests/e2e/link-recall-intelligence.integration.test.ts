/**
 * Link & Recall Intelligence Suite - end-to-end composition over one
 * vault: a wikilink to a frontmatter alias materializes at index time
 * (t_d6660a83), bridge discovery proposes the embedding-near unlinked
 * pair and accept wires it (t_ab540afe), community detection
 * materializes a cluster note (t_4ba927ec), the recall benchmark
 * scores the vault (t_e2215d49), self-tuning persists a grid choice
 * that search honors under the flag (t_ae973491) with deterministic
 * expansion (t_2fa95db1), and every surface left a run-level record
 * in Brain/metrics/ - the dashboard contract.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acceptBridge,
  discoverBridges,
  readDismissedBridges,
  writeBridgeProposals,
} from "../../src/core/brain/link-graph/bridge-discovery.ts";
import {
  detectCommunities,
  materializeClusterNotes,
} from "../../src/core/brain/link-graph/communities.ts";
import { appendMetric, listMetrics } from "../../src/core/brain/metrics.ts";
import { isoSecond } from "../../src/core/brain/time.ts";
import {
  parseRecallBenchmarkDataset,
  runRecallBenchmark,
} from "../../src/core/search/benchmark.ts";
import { tuneRecall } from "../../src/core/search/tuning.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { search } from "../../src/core/search/search.ts";
import { Store } from "../../src/core/search/store.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../src/core/search/types.ts";

const NOW = new Date("2026-06-05T12:00:00Z");

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-lri-e2e-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = makeConfig({
    vault,
    dbPath: join(vault, "index.sqlite"),
    semantic: { enabled: true, provider: "local", dimension: 256 },
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("the suite composes end to end on one vault", async () => {
  // -- 1. Vault: an alias owner, twin unlinked notes, one community ------
  // "the" is seeded into the majority of the prose notes below (but NOT
  // weekly-review.md) so that the DF-driven, language-agnostic common-token
  // filter treats it as corpus-common and drops it from the implicit-AND
  // lex lane - the language-neutral replacement for the old English
  // stopword list. weekly-review.md is the recovery target, so it must
  // omit "the" for the bare implicit-AND query to miss it.
  writeFileSync(
    join(vault, "project-alpha.md"),
    '---\ntitle: Project Alpha\naliases: ["PA"]\n---\n\n# Project Alpha\n\nThe umbrella initiative covers the importer, the dashboard, and the billing pipeline.\n',
  );
  writeFileSync(
    join(vault, "weekly-review.md"),
    "# Weekly review\n\nProgress on [[PA]]: importer merged, dashboard design approved.\n",
  );
  writeFileSync(
    join(vault, "alpha-deploy.md"),
    "# Canary deployment runbook\n\nShip the canary release to one production instance, watch error rates, expand the deployment gradually, roll back on regression.\n",
  );
  writeFileSync(
    join(vault, "beta-deploy.md"),
    "# Deployment safety checklist\n\nCanary release first: one production instance, watch error rates, expand deployment gradually, roll back the release on regression.\n",
  );
  const team = ["team-a", "team-b", "team-c", "team-d"];
  for (const name of team) {
    const others = team
      .filter((t) => t !== name)
      .map((t) => `[[${t}]]`)
      .join(" ");
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nSee the related teams ${others}.\n`);
  }

  // -- 2. Alias resolution materializes at index time --------------------
  const stats = await indexVault(config, { embeddings: true });
  expect(stats.aliasResolved).toBe(1);
  expect(listMetrics(vault, { surface: "index" })).toHaveLength(1);

  // -- 3. Bridge discovery: twin pair proposed, accept wires it ----------
  const store = await Store.open(config, { mode: "read" });
  try {
    const report = discoverBridges(store, {
      minSimilarity: 0.5,
      dismissed: readDismissedBridges(vault),
    });
    expect(report.vecAvailable).toBe(true);
    const pair = report.proposals.find(
      (p) => [p.source, p.target].toSorted().join("|") === "alpha-deploy.md|beta-deploy.md",
    );
    expect(pair).toBeDefined();
    writeBridgeProposals(vault, report, { now: NOW });
    appendMetric(vault, {
      surface: "bridge_discovery",
      runAt: isoSecond(NOW),
      payload: { proposals: report.proposals.length },
    });

    const accepted = acceptBridge(vault, pair!.source, pair!.target);
    expect(accepted.changed).toBe(true);

    // -- 4. Communities: the 4-clique materializes a cluster note --------
    const communities = detectCommunities(store, { minSize: 4 });
    expect(communities.some((c) => c.size === 4)).toBe(true);
    const materialized = materializeClusterNotes(vault, communities, { store, now: NOW });
    expect(materialized.written.length).toBeGreaterThanOrEqual(1);
    appendMetric(vault, {
      surface: "communities",
      runAt: isoSecond(NOW),
      payload: { communities: communities.length },
    });
    expect(readdirSync(join(vault, "Brain", "clusters")).length).toBeGreaterThanOrEqual(1);
  } finally {
    await store.close();
  }

  // -- 5. Reindex sees the accepted bridge: pair no longer proposed ------
  await indexVault(config, { embeddings: true });
  const store2 = await Store.open(config, { mode: "read" });
  try {
    const second = discoverBridges(store2, {
      minSimilarity: 0.5,
      dismissed: readDismissedBridges(vault),
    });
    expect(
      second.proposals.some(
        (p) => [p.source, p.target].toSorted().join("|") === "alpha-deploy.md|beta-deploy.md",
      ),
    ).toBe(false);
  } finally {
    await store2.close();
  }

  // -- 6. Benchmark scores the vault, alias hop included -----------------
  const dataset = parseRecallBenchmarkDataset({
    queries: [
      { id: "canary", query: "canary deployment runbook", expected: ["alpha-deploy.md"] },
      { id: "alias-hop", query: "PA importer dashboard", expected: ["project-alpha.md"] },
      { id: "stopword", query: "the weekly review importer", expected: ["weekly-review.md"] },
    ],
  });
  const bench = await runRecallBenchmark(config, dataset, { k: 5 });
  expect(bench.perQuery.find((q) => q.id === "canary")!.hit).toBe(true);
  expect(bench.perQuery.find((q) => q.id === "alias-hop")!.hit).toBe(true);
  appendMetric(vault, {
    surface: "recall_benchmark",
    runAt: isoSecond(NOW),
    payload: { mrr: bench.mrr, hit_at_k: bench.hitAtK },
  });

  // -- 7. Self-tuning: expansion wins on the stopword query. Tuning
  // runs keyword-only so the lex lane decides - with the semantic
  // layer on, the vec lane already recovers the stopword case and the
  // grid points tie.
  const kwConfig = makeConfig({ vault, dbPath: join(vault, "index.sqlite") });
  const tuneReport = await tuneRecall(kwConfig, dataset, {
    grid: [
      { poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: false },
      { poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: true },
    ],
    now: NOW,
  });
  expect(tuneReport.chosen.expansion).toBe(true);
  appendMetric(vault, {
    surface: "self_tuning",
    runAt: isoSecond(NOW),
    payload: { chosen: tuneReport.chosen },
  });

  const tunedConfig = makeConfig({
    vault,
    dbPath: join(vault, "index.sqlite"),
    selfTuningEnabled: true,
  });
  const tunedSearch = await search(tunedConfig, { query: "the weekly review importer" });
  expect(tunedSearch.results.some((r) => r.path === "weekly-review.md")).toBe(true);

  // -- 8. Dashboard contract: every surface left a record ----------------
  const surfaces = new Set(listMetrics(vault).map((m) => m.surface));
  for (const surface of [
    "index",
    "bridge_discovery",
    "communities",
    "recall_benchmark",
    "self_tuning",
  ]) {
    expect(surfaces.has(surface)).toBe(true);
  }
});
