import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFrontmatter } from "../../../src/core/vault.ts";
import { tombstone } from "../../../src/core/brain/lifecycle/tombstone.ts";
import { temporalReplace } from "../../../src/core/brain/lifecycle/temporal-replace.ts";
import {
  CLAIM_GRAPH_MAX_NODES,
  allClaims,
  buildClaimGraph,
  currentTruth,
  loadClaimGraph,
  rebuildClaimGraph,
  truthAt,
  whatContests,
  whatReplaced,
} from "../../../src/core/brain/claim-graph.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-claim-graph-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeFact(slug: string, meta: Record<string, string | string[]> = {}): string {
  const rel = join("Brain", "preferences", `pref-${slug}.md`);
  writeFrontmatter(
    join(vault, rel),
    {
      kind: "brain-preference",
      id: `pref-${slug}`,
      _status: "confirmed",
      topic: slug,
      principle: `fact ${slug}`,
      tags: ["brain"],
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-02-01T00:00:00Z",
      ...meta,
    },
    "Prose.",
  );
  return rel;
}

test("buildClaimGraph projects nodes from existing frontmatter relations", () => {
  writeFact("a", { provenance: "stated" });
  writeFact("b", { contradicts: ["[[pref-a]]"] });

  const graph = buildClaimGraph(vault);
  expect(graph.nodes.length).toBe(2);
  const a = graph.nodes.find((n) => n.id === "pref-a")!;
  const b = graph.nodes.find((n) => n.id === "pref-b")!;
  expect(a.provenance).toBe("stated");
  expect(b.contradicts).toContain("pref-a");
});

test("currentTruth excludes tombstoned claims but keeps live tips", () => {
  writeFact("live");
  const doomed = writeFact("doomed");
  tombstone({ vault, path: doomed, reason: "wrong", now: new Date("2026-07-18T00:00:00Z") });

  const graph = buildClaimGraph(vault);
  const truth = currentTruth(graph);
  const ids = truth.map((n) => n.id);
  expect(ids).toContain("pref-live");
  expect(ids).not.toContain("pref-doomed");
});

test("history (allClaims) includes tombstoned claims for audit", () => {
  const doomed = writeFact("doomed");
  tombstone({ vault, path: doomed, reason: "wrong", now: new Date("2026-07-18T00:00:00Z") });

  const graph = buildClaimGraph(vault);
  expect(allClaims(graph).map((n) => n.id)).toContain("pref-doomed");
});

test("truthAt returns the historically-valid claim at a past instant", () => {
  const pred = writeFact("v1", { valid_from: "2026-01-01T00:00:00Z" });
  const succ = writeFact("v2");
  temporalReplace({ vault, predecessor: pred, successor: succ, at: "2026-06-01T00:00:00Z" });

  const graph = buildClaimGraph(vault);
  // Before the switch: v1 is the truth (temporal-replace does not tombstone).
  const past = truthAt(graph, Date.parse("2026-03-01T00:00:00Z")).map((n) => n.id);
  expect(past).toContain("pref-v1");
  expect(past).not.toContain("pref-v2");
  // After the switch: v2 is the truth.
  const now = truthAt(graph, Date.parse("2026-09-01T00:00:00Z")).map((n) => n.id);
  expect(now).toContain("pref-v2");
  expect(now).not.toContain("pref-v1");
});

test("whatReplaced follows the supersede chain to the live tip", () => {
  const pred = writeFact("old");
  const succ = writeFact("new");
  temporalReplace({ vault, predecessor: pred, successor: succ, at: "2026-06-01T00:00:00Z" });

  const graph = buildClaimGraph(vault);
  const tip = whatReplaced(graph, "pref-old");
  expect(tip?.id).toBe("pref-new");
});

test("whatContests returns claims on either side of a contradiction", () => {
  writeFact("x");
  writeFact("y", { contradicts: ["[[pref-x]]"] });

  const graph = buildClaimGraph(vault);
  expect(whatContests(graph, "pref-x").map((n) => n.id)).toContain("pref-y");
  expect(whatContests(graph, "pref-y").map((n) => n.id)).toContain("pref-x");
});

test("rebuild persists a JSON artifact and loadClaimGraph reads it back", () => {
  writeFact("a");
  const built = rebuildClaimGraph(vault);
  const loaded = loadClaimGraph(vault);
  expect(loaded).not.toBeNull();
  expect(loaded!.nodes.map((n) => n.id)).toEqual(built.nodes.map((n) => n.id));
});

test("rebuild is deterministic: identical vault state yields identical nodes", () => {
  writeFact("b");
  writeFact("a");
  writeFact("c");
  const g1 = buildClaimGraph(vault);
  const g2 = buildClaimGraph(vault);
  expect(g2.nodes).toEqual(g1.nodes);
  // Sorted by a stable key so the projection is byte-stable across rebuilds.
  const paths = g1.nodes.map((n) => n.path);
  expect(paths).toEqual([...paths].toSorted());
});

test("the projection is bounded by a node cap", () => {
  for (let i = 0; i < 5; i++) writeFact(`n${i}`);
  const graph = buildClaimGraph(vault, { maxNodes: 3 });
  expect(graph.nodes.length).toBe(3);
  expect(graph.truncated).toBe(true);
  expect(CLAIM_GRAPH_MAX_NODES).toBeGreaterThan(0);
});

test("loadClaimGraph returns null when no projection has been built", () => {
  expect(loadClaimGraph(vault)).toBeNull();
});
