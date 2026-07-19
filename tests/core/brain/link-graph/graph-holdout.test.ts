/**
 * Graph-efficacy holdout harness (G1, t_6832aac6).
 *
 * Graph-neighbor holdouts measure graph lift separately from direct recall. A
 * graph target must resolve to durable memory and hydrate into bounded
 * evidence; a dangling edge (target that resolves to nothing) fails the gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  HOLDOUT_EVIDENCE_MAX_CHARS,
  evaluateGraphHoldouts,
  type GraphHoldout,
} from "../../../../src/core/brain/link-graph/graph-holdout.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-holdout-"));
  mkdirSync(join(vault, "Notes"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeNote(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, ["---", "kind: brain-note", "---", "", body, ""].join("\n"), "utf8");
}

describe("evaluateGraphHoldouts resolution and hydration", () => {
  test("a resolvable target hydrates into bounded evidence and the gate passes", () => {
    // anchor links directly to direct.md; direct.md links to neighbor.md.
    writeNote("Notes/anchor.md", "See [[Notes/direct.md]].");
    writeNote("Notes/direct.md", "See [[Notes/neighbor.md]]. Slashing risk compounds.");
    writeNote("Notes/neighbor.md", "Withdrawal queues lengthen under stress.");

    const holdouts: GraphHoldout[] = [
      { anchor: "Notes/anchor.md", target: "Notes/direct.md" },
      { anchor: "Notes/anchor.md", target: "Notes/neighbor.md" },
    ];
    const result = evaluateGraphHoldouts(vault, holdouts);
    expect(result.passed).toBe(true);
    expect(result.danglingCount).toBe(0);
    expect(result.resolvedCount).toBe(2);
    for (const resolution of result.resolutions) {
      expect(resolution.hydrated).toBe(true);
      expect(resolution.evidenceChars).toBeGreaterThan(0);
      expect(resolution.evidenceChars).toBeLessThanOrEqual(HOLDOUT_EVIDENCE_MAX_CHARS);
    }
  });

  test("graph lift is measured separately from direct recall", () => {
    writeNote("Notes/anchor.md", "See [[Notes/direct.md]].");
    writeNote("Notes/direct.md", "See [[Notes/neighbor.md]].");
    writeNote("Notes/neighbor.md", "reachable only through the graph edge");

    const result = evaluateGraphHoldouts(vault, [
      { anchor: "Notes/anchor.md", target: "Notes/direct.md" },
      { anchor: "Notes/anchor.md", target: "Notes/neighbor.md" },
    ]);
    // direct.md is a 1-hop neighbor of anchor: direct recall.
    expect(result.directRecall).toBe(1);
    // neighbor.md is reachable only via the graph (2-hop): graph lift.
    expect(result.graphLift).toBe(1);
  });
});

describe("evaluateGraphHoldouts dangling gate", () => {
  test("a dangling edge fails the gate", () => {
    writeNote("Notes/anchor.md", "See [[Notes/ghost.md]].");
    const result = evaluateGraphHoldouts(vault, [
      { anchor: "Notes/anchor.md", target: "Notes/ghost.md" },
    ]);
    expect(result.passed).toBe(false);
    expect(result.danglingCount).toBe(1);
    expect(result.resolutions[0]!.dangling).toBe(true);
    expect(result.resolutions[0]!.hydrated).toBe(false);
  });
});

describe("evaluateGraphHoldouts hydration gate", () => {
  test("a resolved-but-empty target fails the gate as unhydrated", () => {
    // empty.md resolves (the note exists) but its body is empty, so it does
    // not hydrate into bounded evidence: not dangling, but still a gate failure.
    writeNote("Notes/anchor.md", "See [[Notes/empty.md]].");
    writeNote("Notes/empty.md", "");

    const result = evaluateGraphHoldouts(vault, [
      { anchor: "Notes/anchor.md", target: "Notes/empty.md" },
    ]);
    expect(result.passed).toBe(false);
    expect(result.danglingCount).toBe(0);
    expect(result.unhydratedCount).toBe(1);
    expect(result.resolvedCount).toBe(1);
    expect(result.resolutions[0]!.resolved).toBe(true);
    expect(result.resolutions[0]!.dangling).toBe(false);
    expect(result.resolutions[0]!.hydrated).toBe(false);
    expect(result.resolutions[0]!.evidenceChars).toBe(0);
  });
});
