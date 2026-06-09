/**
 * Opt-in self-tuning recall (link-recall-intelligence, t_ae973491):
 * a bounded parameter grid (pool multiplier, traversal depth, learned
 * weights, expansion) evaluated deterministically against the recall
 * benchmark; the winner persists to Brain/search/tuning.json and
 * search() consults it ONLY when self-tuning is enabled. Replayable:
 * delete the file and nothing else changes; out-of-bounds values are
 * ignored on read.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyTunedParameters,
  defaultTuningGrid,
  loadTunedParameters,
  resetTuning,
  tuneRecall,
} from "../../../src/core/search/tuning.ts";
import { parseRecallBenchmarkDataset } from "../../../src/core/search/benchmark.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const NOW = new Date("2026-06-05T12:00:00Z");

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-tuning-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = makeConfig({ vault, dbPath: join(vault, "index.sqlite") });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const DATASET = parseRecallBenchmarkDataset({
  queries: [
    { id: "canary", query: "canary rollout", expected: ["canary.md"] },
    { id: "stopword", query: "the nightly backup", expected: ["backup.md"] },
  ],
});

// "the" is deliberately seeded into 2 of the 3 notes (canary, other) but
// NOT into backup.md. It is therefore corpus-common (>= 50% document
// frequency) and dropped from the implicit-AND lex lane by the
// language-agnostic, DF-driven common-token filter - which is what lets
// the "the nightly backup" query reach backup.md only WITH expansion.
function writeNotes(): void {
  writeFileSync(
    join(vault, "canary.md"),
    "# Canary rollout\n\nShip the first instance, observe, then expand the rollout gradually.\n",
  );
  writeFileSync(
    join(vault, "backup.md"),
    "# Nightly backup\n\nSnapshot databases every night, verify checksums offsite.\n",
  );
  writeFileSync(
    join(vault, "other.md"),
    "# Other\n\nNothing in the list here is relevant to the task.\n",
  );
}

describe("grid + apply", () => {
  test("the default grid is bounded, stable, and starts at the defaults", () => {
    const grid = defaultTuningGrid();
    expect(grid).toHaveLength(24);
    expect(grid[0]).toEqual({
      poolMultiplier: 3,
      traversalDepth: 1,
      learnedWeights: false,
      expansion: false,
    });
    expect(defaultTuningGrid()).toEqual(grid);
  });

  test("applyTunedParameters overrides recall knobs and disarms recursion", () => {
    const tuned = applyTunedParameters(config, {
      poolMultiplier: 5,
      traversalDepth: 2,
      learnedWeights: true,
      expansion: false,
    });
    expect(tuned.recall.poolMultiplier).toBe(5);
    expect(tuned.recall.maxHops).toBe(2);
    expect(tuned.recall.learnedWeightsEnabled).toBe(true);
    expect(tuned.recall.selfTuningEnabled).toBe(false);
    // The base config is untouched.
    expect(config.recall.poolMultiplier).toBe(3);
  });
});

describe("tuneRecall", () => {
  test("evaluates the grid, persists the winner, and is deterministic", async () => {
    writeNotes();
    await indexVault(config);
    const grid = [
      { poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: false },
      { poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: true },
    ];
    const first = await tuneRecall(config, DATASET, { grid, now: NOW });
    // The stopword query only hits with expansion - it must win.
    expect(first.chosen.expansion).toBe(true);
    expect(first.evaluated).toHaveLength(2);

    const raw = JSON.parse(readFileSync(join(vault, "Brain", "search", "tuning.json"), "utf8")) as {
      schema: string;
      chosen: { expansion: boolean };
      dataset_hash: string;
    };
    expect(raw.schema).toBe("o2b.tuning.v1");
    expect(raw.chosen.expansion).toBe(true);

    const second = await tuneRecall(config, DATASET, { grid, now: NOW });
    expect(second.chosen).toEqual(first.chosen);
    expect(second.evaluated).toEqual(first.evaluated);
  });

  test("loadTunedParameters round-trips and rejects out-of-bounds values", async () => {
    writeNotes();
    await indexVault(config);
    const grid = [
      { poolMultiplier: 4, traversalDepth: 2, learnedWeights: false, expansion: false },
    ];
    await tuneRecall(config, DATASET, { grid, now: NOW });
    expect(loadTunedParameters(vault)).toEqual(grid[0]!);

    const path = join(vault, "Brain", "search", "tuning.json");
    const tampered = JSON.parse(readFileSync(path, "utf8")) as {
      chosen: { poolMultiplier: number };
    };
    tampered.chosen.poolMultiplier = 99;
    writeFileSync(path, JSON.stringify(tampered));
    expect(loadTunedParameters(vault)).toBeNull();

    writeFileSync(path, "{not json");
    expect(loadTunedParameters(vault)).toBeNull();
  });

  test("resetTuning removes the persisted state", async () => {
    writeNotes();
    await indexVault(config);
    await tuneRecall(config, DATASET, {
      grid: [{ poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: false }],
      now: NOW,
    });
    expect(resetTuning(vault)).toBe(true);
    expect(existsSync(join(vault, "Brain", "search", "tuning.json"))).toBe(false);
    expect(loadTunedParameters(vault)).toBeNull();
    expect(resetTuning(vault)).toBe(false);
  });
});

describe("search() under self-tuning", () => {
  test("opt-out ignores a persisted tuning file entirely", async () => {
    writeNotes();
    await indexVault(config);
    mkdirSync(join(vault, "Brain", "search"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "search", "tuning.json"),
      JSON.stringify({
        schema: "o2b.tuning.v1",
        chosen: { poolMultiplier: 5, traversalDepth: 2, learnedWeights: false, expansion: true },
      }),
    );
    // selfTuningEnabled is false in the default test config.
    const outcome = await search(config, { query: "the nightly backup" });
    expect(outcome.results).toHaveLength(0);
  });

  test("opt-in applies the tuned expansion to a bare query", async () => {
    writeNotes();
    await indexVault(config);
    mkdirSync(join(vault, "Brain", "search"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "search", "tuning.json"),
      JSON.stringify({
        schema: "o2b.tuning.v1",
        chosen: { poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: true },
      }),
    );
    const tunedConfig = makeConfig({
      vault,
      dbPath: join(vault, "index.sqlite"),
      selfTuningEnabled: true,
    });
    const outcome = await search(tunedConfig, { query: "the nightly backup" });
    expect(outcome.results.some((r) => r.path === "backup.md")).toBe(true);

    // An explicit expand: false wins over the tuned default.
    const explicit = await search(tunedConfig, { query: "the nightly backup", expand: false });
    expect(explicit.results).toHaveLength(0);
  });
});
