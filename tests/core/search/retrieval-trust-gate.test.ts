/**
 * Retrieval trust gate over the real search path (t_5f61130a), with the
 * session-mining-economy measure-only mode (t_05a0eaa4).
 *
 * Three resolved modes:
 *   - off (default): byte-identical ranking and outcome shape.
 *   - shadow: the classification runs, nothing is excluded, and every
 *     would-be refusal is recorded with its structural reasons into the
 *     receipts, whose `excluded` counts stay untouched.
 *   - enforce: today's excluding behavior, made explicit.
 *
 * The legacy `search_trust_gate_enabled` boolean alone now maps to
 * shadow: a vault must name `enforce` to exclude.
 */

import { test, expect, beforeEach, afterEach, describe, spyOn } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { BrainSearchResult, ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { UNTRUSTED_SOURCE_TAG } from "../../../src/core/brain/untrusted-source.ts";
import { ENTITY_CONTAMINATION_FRONTMATTER_KEY } from "../../../src/core/brain/truth/contamination.ts";
import {
  EXPLAIN_OFF,
  explainEnvelope,
  RETRIEVAL_DECISION_TRACE_KEY,
  RETRIEVAL_TRUST_GATE_MODE_KEY,
} from "../../../src/core/search/explain-envelope.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("trust-gate"));
});

afterEach(() => cleanup());

/**
 * Name the gate mode explicitly on an already-resolved config: the mode
 * is a recall knob of the resolved config, spread-omitted at off.
 */
function withMode(cfg: ResolvedSearchConfig, mode: "shadow" | "enforce"): ResolvedSearchConfig {
  return { ...cfg, recall: { ...cfg.recall, searchTrustGateMode: mode } };
}

function stableProjection(r: BrainSearchResult) {
  return {
    path: r.path,
    searchType: r.searchType,
    keywordScore: r.keywordScore,
    reasons: r.reasons.filter((reason) => !reason.startsWith("recency:")),
  };
}

const CLEAN = "# Clean\n\nThe widget calibration routine runs every morning.";
const QUARANTINED = "---\nstatus: quarantine\n---\n\n# Bad\n\nThe widget calibration is unsafe.";

describe("retrieval trust gate on the search path", () => {
  test("ablation: off vs shadow vs enforce shows the exact deltas", async () => {
    writeMd(vault, "clean.md", CLEAN);
    writeMd(vault, "quarantined.md", QUARANTINED);
    const off = makeConfig({ vault, dbPath });
    const shadow = withMode(off, "shadow");
    const enforce = withMode(off, "enforce");

    await indexVault(off);
    // Freeze the clock across the three searches: recency decay is a
    // continuous function of wall-clock time, so two real Date.now()
    // reads even a millisecond apart would perturb the low-order digits
    // of the compared scores (recency clock drift aside) for reasons
    // that have nothing to do with the gate under test - the same spy
    // the relational-arm byte-identity test carries.
    const nowMs = Date.now();
    const dateNowSpy = spyOn(Date, "now").mockReturnValue(nowMs);
    let gateOff: Awaited<ReturnType<typeof search>>;
    let gateShadow: Awaited<ReturnType<typeof search>>;
    let gateEnforce: Awaited<ReturnType<typeof search>>;
    try {
      gateOff = await search(off, { query: "widget calibration", limit: 5 });
      gateShadow = await search(shadow, { query: "widget calibration", limit: 5 });
      gateEnforce = await search(enforce, { query: "widget calibration", limit: 5 });
    } finally {
      dateNowSpy.mockRestore();
    }

    // Off: both notes surface; no receipts on the outcome.
    expect(gateOff.results.map((r) => r.path).toSorted()).toEqual(["clean.md", "quarantined.md"]);
    expect(gateOff.retrievalDecisionTrace).toBeUndefined();
    expect(gateOff.memoryTrustAssessment).toBeUndefined();

    // Shadow: byte-identical ranking to off - the quarantined note still
    // surfaces - with the refusal measured in the receipts.
    expect(gateShadow.results.map(stableProjection)).toEqual(gateOff.results.map(stableProjection));

    // Enforce: the quarantined note is the only rank delta - excluded -
    // exactly the pre-mode excluding behavior.
    expect(gateEnforce.results.map((r) => r.path)).toEqual(["clean.md"]);
    const removed = gateOff.results
      .map((r) => r.path)
      .filter((p) => !gateEnforce.results.some((r) => r.path === p));
    expect(removed).toEqual(["quarantined.md"]);
    const cleanOff = gateOff.results.find((r) => r.path === "clean.md")!;
    const cleanEnforce = gateEnforce.results.find((r) => r.path === "clean.md")!;
    expect(stableProjection(cleanEnforce)).toEqual(stableProjection(cleanOff));
  });

  test("shadow measures the refusal without excluding: excluded stays untouched", async () => {
    writeMd(vault, "clean.md", CLEAN);
    writeMd(vault, "quarantined.md", QUARANTINED);
    const cfg = withMode(makeConfig({ vault, dbPath }), "shadow");

    await indexVault(cfg);
    const out = await search(cfg, { query: "widget calibration", limit: 5 });

    // Nothing was excluded: the quarantined note surfaces as usual.
    expect(out.results.map((r) => r.path).toSorted()).toEqual(["clean.md", "quarantined.md"]);
    const trace = out.retrievalDecisionTrace!;
    expect(trace.mode).toBe("shadow");
    expect(trace.excluded).toBe(0);
    expect(trace.exclusions).toEqual([]);
    expect(trace.surfaced).toBe(2);
    expect(trace.evaluated).toBe(2);
    expect(trace.refused).toBe(1);
    expect(trace.refusals).toHaveLength(1);
    expect(trace.refusals![0]!.path).toBe("quarantined.md");
    expect(trace.refusals![0]!.reasons).toEqual(["trust_gate:self_approval_quarantine"]);
    expect(trace.refusals![0]!.lane).toBe("pool");
    expect(typeof trace.refusals![0]!.document_id).toBe("number");
    expect(typeof trace.refusals![0]!.chunk_id).toBe("number");

    const assessment = out.memoryTrustAssessment!;
    expect(assessment.mode).toBe("shadow");
    expect(assessment.quarantined).toBe(0);
    expect(assessment.refused).toBe(1);
    // Both lanes are reported; a lane that measured nothing is a
    // measured zero, not an absence.
    expect(assessment.refusals_by_lane).toEqual({ arm: 0, pool: 1 });
    expect(assessment.refused_reason_counts).toEqual({
      pool: { "trust_gate:self_approval_quarantine": 1 },
      arm: {},
    });
  });

  test("the legacy boolean alone now maps to shadow (measure, not exclude)", async () => {
    writeMd(vault, "clean.md", CLEAN);
    writeMd(vault, "quarantined.md", QUARANTINED);
    // No explicit mode: the legacy true maps to shadow.
    const cfg = makeConfig({ vault, dbPath, retrievalTrustGateEnabled: true });

    await indexVault(cfg);
    const out = await search(cfg, { query: "widget calibration", limit: 5 });

    expect(out.results.map((r) => r.path).toSorted()).toEqual(["clean.md", "quarantined.md"]);
    expect(out.retrievalDecisionTrace!.mode).toBe("shadow");
    expect(out.retrievalDecisionTrace!.refused).toBe(1);
    expect(out.retrievalDecisionTrace!.excluded).toBe(0);
  });

  test("enforce named explicitly keeps the excluding behavior and today's receipt shape", async () => {
    writeMd(vault, "clean.md", CLEAN);
    writeMd(vault, "quarantined.md", QUARANTINED);
    const cfg = withMode(makeConfig({ vault, dbPath, retrievalTrustGateEnabled: true }), "enforce");

    await indexVault(cfg);
    const out = await search(cfg, { query: "widget calibration", limit: 5 });

    expect(out.results.map((r) => r.path)).toEqual(["clean.md"]);
    const trace = out.retrievalDecisionTrace!;
    expect(trace.excluded).toBe(1);
    expect(trace.surfaced).toBe(1);
    expect(trace.evaluated).toBe(2);
    expect(trace.exclusions).toHaveLength(1);
    expect(trace.exclusions[0]!.path).toBe("quarantined.md");
    expect(trace.exclusions[0]!.reasons).toEqual(["trust_gate:self_approval_quarantine"]);
    // Enforce reproduces today's shape exactly: no mode key, no refusal
    // section.
    expect("mode" in trace).toBe(false);
    expect("refused" in trace).toBe(false);
    expect("refusals" in trace).toBe(false);
    expect("mode" in out.memoryTrustAssessment!).toBe(false);
  });

  test("untrusted-source and contamination markers are refused under shadow with all reasons", async () => {
    writeMd(vault, "clean.md", CLEAN);
    writeMd(
      vault,
      "untrusted.md",
      `---\n${UNTRUSTED_SOURCE_TAG}: true\n---\n\n# U\n\nwidget calibration from an untrusted source.`,
    );
    writeMd(
      vault,
      "tainted.md",
      `---\n${ENTITY_CONTAMINATION_FRONTMATTER_KEY}: true\n---\n\n# T\n\nwidget calibration tainted claim.`,
    );
    const cfg = withMode(makeConfig({ vault, dbPath }), "shadow");

    await indexVault(cfg);
    const out = await search(cfg, { query: "widget calibration", limit: 5 });

    // Nothing excluded, both would-be refusals measured per lane.
    expect(out.results.map((r) => r.path).toSorted()).toEqual([
      "clean.md",
      "tainted.md",
      "untrusted.md",
    ]);
    const assessment = out.memoryTrustAssessment!;
    expect(assessment.quarantined).toBe(0);
    expect(assessment.refused).toBe(2);
    expect(assessment.refused_reason_counts).toEqual({
      pool: {
        "trust_gate:entity_contamination": 1,
        "trust_gate:untrusted_source_provenance": 1,
      },
      arm: {},
    });
    const refusals = out.retrievalDecisionTrace!.refusals!;
    expect(refusals.map((r) => r.path).toSorted()).toEqual(["tainted.md", "untrusted.md"]);
  });

  test("a clean vault under shadow measures nothing and ranks byte-identically", async () => {
    writeMd(vault, "a.md", "# A\n\nnote about orchard pruning in spring");
    writeMd(vault, "b.md", "# B\n\nnote about orchard irrigation schedules");
    const off = makeConfig({ vault, dbPath });
    const shadow = withMode(off, "shadow");

    await indexVault(off);
    const gateOff = await search(off, { query: "orchard", limit: 5 });
    const gateShadow = await search(shadow, { query: "orchard", limit: 5 });

    expect(gateShadow.results.map(stableProjection)).toEqual(gateOff.results.map(stableProjection));
    const assessment = gateShadow.memoryTrustAssessment!;
    expect(assessment.mode).toBe("shadow");
    expect(assessment.refused).toBe(0);
    expect(assessment.refusals_by_lane).toEqual({ arm: 0, pool: 0 });
    expect(assessment.refused_reason_counts).toEqual({ arm: {}, pool: {} });
  });

  test("the arm lane's refusals ride the receipts end to end under shadow", async () => {
    // The arm's only route to `neighbor.md` is the walk, and its refusal
    // reason is one the page gate never reads - a closed validity window -
    // so the measured arm lane cannot come from the pool's own pass.
    writeMd(vault, "seed.md", '---\nrelated: "[[neighbor]]"\n---\n\nalpha topic seed document.');
    writeMd(vault, "neighbor.md", '---\nvalid_until: "2020-01-01"\n---\n\nbeta divergent content.');
    await indexVault(makeConfig({ vault, dbPath }));
    const configPath = join(vault, "gate-mode.yaml");
    writeFileSync(configPath, "search_trust_gate_mode: shadow\n");
    const cfg = {
      ...makeConfig({
        vault,
        dbPath,
        fusionMode: "rrf",
        relationalArmEnabled: true,
        searchTrustGateMode: "shadow",
      }),
      configPath,
    };

    const out = await search(cfg, { query: "alpha [[seed]] related" });

    // Shadow keeps the arm's contribution: the walked node still surfaces,
    // carrying the arm's attribution.
    const neighbor = out.results.find((r) => r.path === "neighbor.md");
    expect(neighbor).toBeDefined();
    expect(neighbor!.reasons.some((x) => x.startsWith("relational:"))).toBe(true);

    const trace = out.retrievalDecisionTrace!;
    expect(trace.mode).toBe("shadow");
    expect(trace.excluded).toBe(0);
    expect(trace.refused).toBe(1);
    expect(trace.refusals).toEqual([
      {
        document_id: expect.any(Number),
        chunk_id: expect.any(Number),
        path: "neighbor.md",
        reasons: ["relational_arm:closed_validity_window"],
        lane: "arm",
      },
    ]);

    const assessment = out.memoryTrustAssessment!;
    expect(assessment.refused).toBe(1);
    expect(assessment.refusals_by_lane).toEqual({ arm: 1, pool: 0 });
    expect(assessment.refused_reason_counts).toEqual({
      arm: { "relational_arm:closed_validity_window": 1 },
      pool: {},
    });
  });

  test("a withheld quarantined page is receipted identically to its absence under shadow", async () => {
    // The walked page is quarantined AND reserved against the remote
    // caller's reach: no lane may name it in the receipts, so the refusal
    // section reads exactly as it would had the page never existed. A
    // second, readable walk target keeps the pool non-empty on both
    // sides, so the receipts exist to be compared.
    writeMd(
      vault,
      "seed.md",
      '---\nrelated: "[[hidden]]"\nextends: "[[visible]]"\n---\n\nalpha topic seed document.',
    );
    writeMd(
      vault,
      "hidden.md",
      '---\nstatus: quarantine\nvisibility: ["private"]\n---\n\nbeta hidden divergent content.',
    );
    writeMd(vault, "visible.md", "# Visible\n\ngamma readable neighbor content.");
    await indexVault(makeConfig({ vault, dbPath }));
    const configPath = join(vault, "gate-mode.yaml");
    writeFileSync(configPath, "search_trust_gate_mode: shadow\n");
    const cfg = {
      ...makeConfig({
        vault,
        dbPath,
        fusionMode: "rrf",
        relationalArmEnabled: true,
        searchTrustGateMode: "shadow",
      }),
      configPath,
    };

    const present = await search(cfg, {
      query: "alpha [[seed]] related extends",
      transportReach: TRANSPORT_REACH.remote,
    });
    const presentTrace = present.retrievalDecisionTrace!;
    expect(presentTrace.mode).toBe("shadow");
    expect(presentTrace.refused).toBe(0);
    expect(presentTrace.refusals).toEqual([]);

    // The same vault, the page gone: the refusal section is the same
    // bytes (the counts around it legitimately differ - the row vanished).
    rmSync(join(vault, "hidden.md"));
    await indexVault(cfg);
    const absent = await search(cfg, {
      query: "alpha [[seed]] related extends",
      transportReach: TRANSPORT_REACH.remote,
    });
    const absentTrace = absent.retrievalDecisionTrace!;
    expect(JSON.stringify({ refused: presentTrace.refused, refusals: presentTrace.refusals })).toBe(
      JSON.stringify({ refused: absentTrace.refused, refusals: absentTrace.refusals }),
    );
  });

  test("enforce records the arm lane's drops in the receipts (never silently dropped)", async () => {
    // The arm's only route to `dirty.md` is the walk: under enforce the
    // node is removed BEFORE the pool, so no pool exclusion can ever name
    // it. The gate's never-silently-dropped posture holds only if the
    // drop is receipted - on the arm lane, without a shadow mode stamp. A
    // clean second walk target keeps the pool non-empty, so the receipts
    // exist to be read.
    writeMd(
      vault,
      "seed.md",
      '---\nrelated: "[[dirty]]"\nextends: "[[clean2]]"\n---\n\nalpha topic seed document.',
    );
    writeMd(
      vault,
      "dirty.md",
      `---\n${ENTITY_CONTAMINATION_FRONTMATTER_KEY}: true\n---\n\nbeta divergent content.`,
    );
    writeMd(vault, "clean2.md", "# Clean two\n\ngamma readable neighbor content.");
    await indexVault(makeConfig({ vault, dbPath }));
    const configPath = join(vault, "gate-mode.yaml");
    writeFileSync(configPath, "search_trust_gate_mode: enforce\n");
    const cfg = {
      ...makeConfig({
        vault,
        dbPath,
        fusionMode: "rrf",
        relationalArmEnabled: true,
        searchTrustGateMode: "enforce",
      }),
      configPath,
    };

    const out = await search(cfg, { query: "alpha [[seed]] related extends" });

    // The excluding behavior is unchanged: the walked node never surfaces.
    expect(out.results.some((r) => r.path === "dirty.md")).toBe(false);

    const trace = out.retrievalDecisionTrace!;
    expect(trace.refused).toBe(1);
    expect(trace.refusals).toEqual([
      {
        document_id: expect.any(Number),
        chunk_id: expect.any(Number),
        path: "dirty.md",
        reasons: ["relational_arm:entity_contamination"],
        lane: "arm",
      },
    ]);
    // Still not a shadow receipt: no mode stamp on an enforce run.
    expect("mode" in trace).toBe(false);

    const assessment = out.memoryTrustAssessment!;
    expect(assessment.refused).toBe(1);
    expect(assessment.refusals_by_lane).toEqual({ arm: 1, pool: 0 });
    expect(assessment.refused_reason_counts).toEqual({
      arm: { "relational_arm:entity_contamination": 1 },
      pool: {},
    });
    expect("mode" in assessment).toBe(false);
  });

  test("the explain envelope names the resolved mode under shadow and stays silent under enforce", async () => {
    writeMd(vault, "clean.md", CLEAN);
    writeMd(vault, "quarantined.md", QUARANTINED);
    const off = makeConfig({ vault, dbPath });
    await indexVault(off);
    const shadowOutcome = await search(withMode(off, "shadow"), {
      query: "widget calibration",
      limit: 5,
    });
    const enforceOutcome = await search(withMode(off, "enforce"), {
      query: "widget calibration",
      limit: 5,
    });

    const request = { ...EXPLAIN_OFF, explain: true };
    const shadowEnvelope = explainEnvelope(shadowOutcome, request);
    expect(shadowEnvelope[RETRIEVAL_DECISION_TRACE_KEY]).toBeDefined();
    expect(shadowEnvelope[RETRIEVAL_TRUST_GATE_MODE_KEY]).toBe("shadow");

    // Enforce keeps today's envelope exactly: the receipts, no mode key.
    const enforceEnvelope = explainEnvelope(enforceOutcome, request);
    expect(enforceEnvelope[RETRIEVAL_DECISION_TRACE_KEY]).toBeDefined();
    expect(enforceEnvelope[RETRIEVAL_TRUST_GATE_MODE_KEY]).toBeUndefined();
  });
});
