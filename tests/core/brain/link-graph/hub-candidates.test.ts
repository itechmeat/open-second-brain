/**
 * Hub candidates at inbox-drain (t_23bd347d): the deterministic selection of
 * a routed page's area hub and the staged candidate store the repair lane
 * merges.
 *
 * The selection is purely structural: the pool is the corpus pages that pass
 * the moc-audit hub predicate within the routed page's composite scope
 * bucket, decided by the shared exactly-one kernel. Zero hubs and multiple
 * hubs are named refusals, never a silent pick. The store is append-only
 * JSONL under `Brain/.state/` and writes no note.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  HubCandidateError,
  REPAIR_CANDIDATES_STORE_FILE,
  loadStagedHubRecords,
  selectHubCandidate,
  stageHubSelection,
  type HubRefusal,
} from "../../../../src/core/brain/link-graph/hub-candidates.ts";
import {
  IDENTITY_STRENGTH,
  type RepairCandidate,
} from "../../../../src/core/brain/link-graph/repair-lane.ts";
import { BRAIN_INTERNAL_STATE_REL } from "../../../../src/core/brain/path-constants.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hub-candidates-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "captured"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Five unique outbound links: crosses the default moc-audit thresholds. */
const HUB_LINKS = "[[alpha]] [[beta]] [[gamma]] [[delta]] [[epsilon]]";

const ROUTED = "captured/cdk-deploy-notes.md";

function writePage(rel: string, frontmatter: Record<string, string>, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`);
  lines.push("---", "", body, "");
  writeFileSync(abs, lines.join("\n"), "utf8");
}

function writeHub(rel: string, title: string, extra: Record<string, string> = {}): void {
  writePage(rel, { kind: "brain-note", title, ...extra }, HUB_LINKS);
}

function writeRouted(extra: Record<string, string> = {}): void {
  writePage(ROUTED, { kind: "captured-idea", title: "Captured idea", ...extra }, "an atomic idea");
}

function storePath(): string {
  return join(vault, BRAIN_INTERNAL_STATE_REL, REPAIR_CANDIDATES_STORE_FILE);
}

/** Write raw store content, creating the internal-state directory first. */
function writeStore(text: string): void {
  mkdirSync(join(vault, BRAIN_INTERNAL_STATE_REL), { recursive: true });
  writeFileSync(storePath(), text, "utf8");
}

function stagedCandidate(overrides: Partial<RepairCandidate>): RepairCandidate {
  return {
    source: "captured/idea.md",
    target: "Brain/areas/ops.md",
    strength: IDENTITY_STRENGTH.areaMembership,
    confidence: 1,
    reason: "area hub Brain/areas/ops.md for scope bucket (unscoped)",
    ...overrides,
  };
}

function stagedRefusal(overrides: Partial<HubRefusal>): HubRefusal {
  return {
    source: "captured/idea.md",
    target: "",
    strength: IDENTITY_STRENGTH.areaMembership,
    confidence: 1,
    action: "skip-no-hub",
    reason: "no hub page in scope bucket (unscoped)",
    ...overrides,
  };
}

describe("selectHubCandidate", () => {
  test("a unique scope-matching hub yields a full-confidence candidate naming the hub", () => {
    writeRouted();
    writeHub("Brain/areas/ops.md", "Ops Hub");
    const selection = selectHubCandidate(vault, ROUTED);
    expect(selection.outcome).toBe("candidate");
    if (selection.outcome !== "candidate") return;
    expect(selection.candidate.source).toBe(ROUTED);
    expect(selection.candidate.target).toBe("Brain/areas/ops.md");
    expect(selection.candidate.strength).toBe(IDENTITY_STRENGTH.areaMembership);
    expect(selection.candidate.confidence).toBe(1);
    expect(selection.candidate.reason).toContain("Brain/areas/ops.md");
  });

  test("zero hub pages yields a skip-no-hub refusal naming the scope bucket", () => {
    writeRouted();
    writePage(
      "Brain/areas/prose.md",
      { kind: "brain-note", title: "Prose" },
      "plain prose that links nothing and is no hub",
    );
    const selection = selectHubCandidate(vault, ROUTED);
    expect(selection.outcome).toBe("refusal");
    if (selection.outcome !== "refusal") return;
    expect(selection.refusal.action).toBe("skip-no-hub");
    expect(selection.refusal.source).toBe(ROUTED);
    expect(selection.refusal.reason).toContain("(unscoped)");
  });

  test("multiple hub pages yield a skip-ambiguous-hub refusal listing every hub in first-occurrence order", () => {
    writeRouted();
    writeHub("Brain/areas/beta-hub.md", "Beta Hub");
    writeHub("Brain/areas/alpha-hub.md", "Alpha Hub");
    const selection = selectHubCandidate(vault, ROUTED);
    expect(selection.outcome).toBe("refusal");
    if (selection.outcome !== "refusal") return;
    expect(selection.refusal.action).toBe("skip-ambiguous-hub");
    expect(selection.refusal.reason).toContain("2 hub pages");
    const alpha = selection.refusal.reason.indexOf("Brain/areas/alpha-hub.md");
    const beta = selection.refusal.reason.indexOf("Brain/areas/beta-hub.md");
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(beta).toBeGreaterThan(alpha);
  });

  test("a hub outside the routed page's scope bucket is never considered", () => {
    writeRouted({ project: "atlas" });
    writeHub("Brain/areas/ops.md", "Ops Hub", { project: "other" });
    writeHub("Brain/areas/atlas-hub.md", "Atlas Hub", { project: "atlas" });
    const selection = selectHubCandidate(vault, ROUTED);
    expect(selection.outcome).toBe("candidate");
    if (selection.outcome !== "candidate") return;
    expect(selection.candidate.target).toBe("Brain/areas/atlas-hub.md");
  });

  test("a scopeless routed page matches scopeless hubs only", () => {
    writeRouted();
    writeHub("Brain/areas/ops.md", "Ops Hub", { project: "atlas" });
    const selection = selectHubCandidate(vault, ROUTED);
    expect(selection.outcome).toBe("refusal");
    if (selection.outcome !== "refusal") return;
    expect(selection.refusal.action).toBe("skip-no-hub");
  });

  test("the routed page is never its own hub", () => {
    writeHub(ROUTED, "Ops Hub");
    const selection = selectHubCandidate(vault, ROUTED);
    expect(selection.outcome).toBe("refusal");
    if (selection.outcome !== "refusal") return;
    expect(selection.refusal.action).toBe("skip-no-hub");
  });

  test("thresholds come from the link_graph config, not a hardcoded floor", () => {
    writeRouted();
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nlink_graph:\n  moc_min_outbound_links: 2\n",
      "utf8",
    );
    // Two unique links cross the configured floor but not the default 5.
    writePage(
      "Brain/areas/small-hub.md",
      { kind: "brain-note", title: "Small Hub" },
      "[[alpha]] [[beta]]",
    );
    const selection = selectHubCandidate(vault, ROUTED);
    expect(selection.outcome).toBe("candidate");
    if (selection.outcome !== "candidate") return;
    expect(selection.candidate.target).toBe("Brain/areas/small-hub.md");
  });

  test("a routed page that does not exist is a named error, never a silent refusal", () => {
    expect(() => selectHubCandidate(vault, "captured/missing.md")).toThrow(HubCandidateError);
  });
});

describe("staged store", () => {
  test("a staged candidate round-trips through the store", () => {
    stageHubSelection(vault, { outcome: "candidate", candidate: stagedCandidate({}) });
    const staged = loadStagedHubRecords(vault);
    expect(staged.candidates).toHaveLength(1);
    expect(staged.refusals).toHaveLength(0);
    expect(staged.candidates[0]).toEqual(stagedCandidate({}));
    expect(existsSync(storePath())).toBe(true);
  });

  test("a staged refusal round-trips with its action", () => {
    const refusal = stagedRefusal({ action: "skip-ambiguous-hub", reason: "2 hub pages: a, b" });
    stageHubSelection(vault, { outcome: "refusal", refusal });
    const staged = loadStagedHubRecords(vault);
    expect(staged.candidates).toHaveLength(0);
    expect(staged.refusals).toHaveLength(1);
    expect(staged.refusals[0]).toEqual(refusal);
  });

  test("staging the same selection twice appends it once", () => {
    const selection = { outcome: "candidate", candidate: stagedCandidate({}) } as const;
    stageHubSelection(vault, selection);
    stageHubSelection(vault, selection);
    expect(loadStagedHubRecords(vault).candidates).toHaveLength(1);
  });

  test("distinct selections append separately", () => {
    writePage("captured/idea.md", { kind: "captured-idea" }, "idea");
    writePage("captured/other.md", { kind: "captured-idea" }, "other");
    stageHubSelection(vault, { outcome: "candidate", candidate: stagedCandidate({}) });
    stageHubSelection(vault, {
      outcome: "candidate",
      candidate: stagedCandidate({ source: "captured/other.md" }),
    });
    expect(loadStagedHubRecords(vault).candidates).toHaveLength(2);
  });

  test("a newer decision for the same page replaces the older one", () => {
    stageHubSelection(vault, { outcome: "refusal", refusal: stagedRefusal({}) });
    stageHubSelection(vault, { outcome: "candidate", candidate: stagedCandidate({}) });
    const staged = loadStagedHubRecords(vault);
    expect(staged.refusals).toHaveLength(0);
    expect(staged.candidates).toEqual([stagedCandidate({})]);
  });

  test("a record whose routed page no longer exists is pruned and counted", () => {
    stageHubSelection(vault, {
      outcome: "candidate",
      candidate: stagedCandidate({ source: "captured/gone.md" }),
    });
    const result = stageHubSelection(vault, {
      outcome: "candidate",
      candidate: stagedCandidate({}),
    });
    expect(result.pruned).toBe(1);
    expect(loadStagedHubRecords(vault).candidates.map((c) => c.source)).toEqual([
      "captured/idea.md",
    ]);
  });

  test("staging over a corrupt line drops it and counts it instead of throwing", () => {
    writeStore("not json\n");
    const result = stageHubSelection(vault, {
      outcome: "candidate",
      candidate: stagedCandidate({}),
    });
    expect(result.skippedCorrupt).toBe(1);
    expect(loadStagedHubRecords(vault).candidates).toHaveLength(1);
  });

  test("no staged file reads as empty, not as an error", () => {
    const staged = loadStagedHubRecords(vault);
    expect(staged.candidates).toHaveLength(0);
    expect(staged.refusals).toHaveLength(0);
  });

  test("a corrupt line is a named error carrying the line number", () => {
    writeStore("not json\n");
    expect(() => loadStagedHubRecords(vault)).toThrow(HubCandidateError);
    expect(() => loadStagedHubRecords(vault)).toThrow(/line 1/);
  });

  test("a record of an unknown kind is a named error", () => {
    writeStore(`${JSON.stringify({ kind: "mystery", source: "x" })}\n`);
    expect(() => loadStagedHubRecords(vault)).toThrow(/unknown record kind/);
  });

  test("a candidate record with an empty target is a named error", () => {
    writeStore(
      `${JSON.stringify({ kind: "candidate", source: "a.md", target: "", strength: "area_membership", confidence: 1, reason: "r" })}\n`,
    );
    expect(() => loadStagedHubRecords(vault)).toThrow(/empty target/);
  });

  test("a record carrying an identity strength this store never writes is a named error", () => {
    writeStore(
      `${JSON.stringify({ kind: "candidate", source: "a.md", target: "b.md", strength: "inferred", confidence: 1, reason: "r" })}\n`,
    );
    expect(() => loadStagedHubRecords(vault)).toThrow(/strength/);
  });
});
