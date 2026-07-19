/**
 * Retrieval trust gate over the real search path (t_5f61130a).
 *
 * With the gate on, quarantined material (classified structurally from
 * frontmatter markers) is zero-ranked - excluded from the pack - while
 * being counted with reasons in the retrieval_decision_trace receipt, and
 * every pack also carries a memory_trust_assessment receipt. With the gate
 * off the ranking output and the outcome shape are byte-identical, which
 * the ablation test asserts directly (exact result / rank deltas).
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import { UNTRUSTED_SOURCE_TAG } from "../../../src/core/brain/untrusted-source.ts";
import { ENTITY_CONTAMINATION_FRONTMATTER_KEY } from "../../../src/core/brain/truth/contamination.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("trust-gate"));
});

afterEach(() => cleanup());

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
  test("ablation: gate off vs on shows the exact result/rank delta", async () => {
    writeMd(vault, "clean.md", CLEAN);
    writeMd(vault, "quarantined.md", QUARANTINED);
    const off = makeConfig({ vault, dbPath });
    const on = makeConfig({ vault, dbPath, retrievalTrustGateEnabled: true });

    await indexVault(off);
    const gateOff = await search(off, { query: "widget calibration", limit: 5 });
    const gateOn = await search(on, { query: "widget calibration", limit: 5 });

    // Gate off: both notes surface; no receipts on the outcome.
    expect(gateOff.results.map((r) => r.path).toSorted()).toEqual(["clean.md", "quarantined.md"]);
    expect(gateOff.retrievalDecisionTrace).toBeUndefined();
    expect(gateOff.memoryTrustAssessment).toBeUndefined();

    // Gate on: the quarantined note is the only rank delta - excluded.
    expect(gateOn.results.map((r) => r.path)).toEqual(["clean.md"]);
    const removed = gateOff.results
      .map((r) => r.path)
      .filter((p) => !gateOn.results.some((r) => r.path === p));
    expect(removed).toEqual(["quarantined.md"]);
    // The surviving note ranks byte-identically (recency clock drift aside).
    const cleanOff = gateOff.results.find((r) => r.path === "clean.md")!;
    const cleanOn = gateOn.results.find((r) => r.path === "clean.md")!;
    expect(stableProjection(cleanOn)).toEqual(stableProjection(cleanOff));
  });

  test("quarantined material reaches no pack but is counted with reasons", async () => {
    writeMd(vault, "clean.md", CLEAN);
    writeMd(vault, "quarantined.md", QUARANTINED);
    const cfg = makeConfig({ vault, dbPath, retrievalTrustGateEnabled: true });

    await indexVault(cfg);
    const out = await search(cfg, { query: "widget calibration", limit: 5 });

    expect(out.results.some((r) => r.path === "quarantined.md")).toBe(false);
    const trace = out.retrievalDecisionTrace!;
    expect(trace.excluded).toBe(1);
    expect(trace.surfaced).toBe(1);
    expect(trace.evaluated).toBe(2);
    expect(trace.exclusions).toHaveLength(1);
    expect(trace.exclusions[0]!.path).toBe("quarantined.md");
    expect(trace.exclusions[0]!.reasons).toEqual(["trust_gate:self_approval_quarantine"]);

    const assessment = out.memoryTrustAssessment!;
    expect(assessment.quarantined).toBe(1);
    expect(assessment.surfaced).toBe(1);
    expect(assessment.reason_counts).toEqual({ "trust_gate:self_approval_quarantine": 1 });
  });

  test("untrusted-source and contamination markers are also excluded", async () => {
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
    const cfg = makeConfig({ vault, dbPath, retrievalTrustGateEnabled: true });

    await indexVault(cfg);
    const out = await search(cfg, { query: "widget calibration", limit: 5 });

    expect(out.results.map((r) => r.path)).toEqual(["clean.md"]);
    const assessment = out.memoryTrustAssessment!;
    expect(assessment.quarantined).toBe(2);
    expect(assessment.reason_counts).toEqual({
      "trust_gate:entity_contamination": 1,
      "trust_gate:untrusted_source_provenance": 1,
    });
  });

  test("a clean vault ranks byte-identically with the gate on or off", async () => {
    writeMd(vault, "a.md", "# A\n\nnote about orchard pruning in spring");
    writeMd(vault, "b.md", "# B\n\nnote about orchard irrigation schedules");
    const off = makeConfig({ vault, dbPath });
    const on = makeConfig({ vault, dbPath, retrievalTrustGateEnabled: true });

    await indexVault(off);
    const gateOff = await search(off, { query: "orchard", limit: 5 });
    const gateOn = await search(on, { query: "orchard", limit: 5 });

    expect(gateOn.results.map(stableProjection)).toEqual(gateOff.results.map(stableProjection));
    // Even with the gate engaged, a clean pack still carries the receipts,
    // reporting zero exclusions.
    const assessment = gateOn.memoryTrustAssessment!;
    expect(assessment.quarantined).toBe(0);
  });
});
