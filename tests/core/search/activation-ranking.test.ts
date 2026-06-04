/**
 * Activation ranking layer (Time-Aware Recall & Activation Suite,
 * t_2bc79017): effective activation becomes a bounded, explainable
 * ranking boost; access recording happens at the orchestrator edge and
 * never affects the query that produced it.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { loadAccessEvents, recordAccessEvent } from "../../../src/core/search/activation/store.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

const QUERY = "perimeter calibration";

function activationReason(reasons: ReadonlyArray<string>): number | null {
  const entry = reasons.find((r) => r.startsWith("activation: "));
  if (entry === undefined) return null;
  return Number(entry.slice("activation: ".length));
}

async function seed(): Promise<void> {
  writeMd(
    vault,
    "Brain/notes/alpha.md",
    "# Alpha\n\nPerimeter calibration baseline notes for the alpha array.\n",
  );
  writeMd(
    vault,
    "Brain/notes/beta.md",
    "# Beta\n\nPerimeter calibration baseline notes for the beta array.\n",
  );
  const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
  await indexVault(config);
}

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("activation-rank"));
});

afterEach(() => {
  cleanup();
});

describe("activation boost", () => {
  test("a vault without access events ranks identically to the layer being off", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const off = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, activationEnabled: false });
    const a = await search(config, { query: QUERY });
    const b = await search(off, { query: QUERY });
    // Same order, same reasons; scores match to recency-drift precision
    // (the Weibull recency layer reads the real clock, so two calls a
    // few ms apart differ in the 9th decimal regardless of activation).
    expect(a.results.map((r) => r.path)).toEqual(b.results.map((r) => r.path));
    a.results.forEach((r, i) => expect(r.score).toBeCloseTo(b.results[i]!.score, 6));
    expect(a.results.every((r) => activationReason(r.reasons) === null)).toBe(true);
  });

  test("recorded accesses surface as a bounded activation reason", async () => {
    await seed();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      recordAccessEvent(vault, {
        ts: now - i * 1000,
        queryHash: "cafe0001",
        paths: ["Brain/notes/beta.md"],
      });
    }
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: QUERY });
    const beta = outcome.results.find((r) => r.path === "Brain/notes/beta.md");
    const alpha = outcome.results.find((r) => r.path === "Brain/notes/alpha.md");
    const betaBoost = activationReason(beta!.reasons);
    expect(betaBoost).not.toBeNull();
    expect(betaBoost!).toBeGreaterThan(0);
    expect(betaBoost!).toBeLessThanOrEqual(0.04);
    expect(activationReason(alpha!.reasons)).toBeNull();
  });

  test("preference pages outlast notes after long idle (type half-life)", async () => {
    writeMd(
      vault,
      "Brain/preferences/pref-calibration.md",
      "---\nkind: brain-preference\n---\n\n# Pref\n\nPerimeter calibration rule.\n",
    );
    await seed();
    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (const p of ["Brain/preferences/pref-calibration.md", "Brain/notes/beta.md"]) {
      recordAccessEvent(vault, { ts: old, queryHash: "cafe0002", paths: [p] });
    }
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    const outcome = await search(config, { query: QUERY, limit: 10 });
    const pref = outcome.results.find((r) => r.path.startsWith("Brain/preferences/"));
    const beta = outcome.results.find((r) => r.path === "Brain/notes/beta.md");
    const prefBoost = activationReason(pref!.reasons);
    const betaBoost = activationReason(beta!.reasons);
    expect(prefBoost).not.toBeNull();
    // The note decayed (60d half-life, 90d idle); the preference did not.
    expect(prefBoost!).toBeGreaterThan(betaBoost ?? 0);
  });

  test("the kill switch suppresses the layer even with events present", async () => {
    await seed();
    recordAccessEvent(vault, {
      ts: Date.now(),
      queryHash: "cafe0003",
      paths: ["Brain/notes/beta.md"],
    });
    const off = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, activationEnabled: false });
    const outcome = await search(off, { query: QUERY });
    expect(outcome.results.every((r) => activationReason(r.reasons) === null)).toBe(true);
  });
});

describe("access recording at the orchestrator edge", () => {
  test("recordAccess writes one event with the surfaced paths", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: QUERY, recordAccess: true });
    expect(outcome.results.length).toBeGreaterThan(0);
    const events = loadAccessEvents(vault);
    expect(events).toHaveLength(1);
    expect(events[0]?.paths).toContain("Brain/notes/alpha.md");
    expect(events[0]?.paths).toContain("Brain/notes/beta.md");
    // Privacy: the event stores a hash, never the raw query.
    expect(JSON.stringify(events[0])).not.toContain("perimeter");
  });

  test("recording is off by default and never affects the current query", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const plain = await search(config, { query: QUERY });
    expect(loadAccessEvents(vault)).toHaveLength(0);
    const recorded = await search(config, { query: QUERY, recordAccess: true });
    expect(plain.results.map((r) => r.path)).toEqual(recorded.results.map((r) => r.path));
    // The recording call's own ranking carries no activation layer (the
    // event lands after ranking); scores match to recency-drift precision.
    plain.results.forEach((r, i) => expect(r.score).toBeCloseTo(recorded.results[i]!.score, 6));
    expect(recorded.results.every((r) => activationReason(r.reasons) === null)).toBe(true);
  });

  test("a zero-result query records nothing", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await search(config, { query: "zzzqxv nonexistent", recordAccess: true });
    expect(loadAccessEvents(vault)).toHaveLength(0);
  });
});
