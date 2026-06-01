import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  rebuildProceduralGraph,
  readProceduralGraph,
} from "../../../src/core/brain/procedural-graph.ts";
import {
  proceduralGraphPath,
  skillProposalAcceptedPath,
} from "../../../src/core/brain/paths.ts";
import { reconcileProceduralMemory } from "../../../src/core/brain/procedural-memory.ts";

let vault: string;

beforeEach(() => {
  vault = join(
    tmpdir(),
    `o2b-procedural-graph-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("procedural graph projection", () => {
  test("rebuilds graph with entry nodes, proposal nodes, and entity links", () => {
    seedProceduralSources(vault);
    reconcileProceduralMemory(vault, {
      roots: [join(vault, "Brain", "procedures"), join(vault, "skills")],
    });

    const projection = rebuildProceduralGraph(vault, {
      now: new Date("2026-06-02T10:00:00Z"),
    });
    expect(projection.schema_version).toBe(1);
    expect(projection.nodes.length).toBeGreaterThanOrEqual(3);
    expect(projection.edges.length).toBeGreaterThan(0);

    const proposalNode = projection.nodes.find(
      (node) => node.kind === "proposal",
    );
    expect(proposalNode).toBeDefined();

    const entityNode = projection.nodes.find((node) => node.kind === "entity");
    expect(entityNode).toBeDefined();

    const restored = readProceduralGraph(vault);
    expect(restored).not.toBeNull();
    expect(restored?.generated_at).toBe("2026-06-02T10:00:00.000Z");
  });

  test("returns null when projection file does not exist", () => {
    expect(readProceduralGraph(vault)).toBeNull();
    expect(
      proceduralGraphPath(vault).endsWith("Brain/procedural-memory/graph.json"),
    ).toBe(true);
  });
});

function seedProceduralSources(vaultPath: string): void {
  const proceduresDir = join(vaultPath, "Brain", "procedures");
  const skillsDir = join(vaultPath, "skills", "release");
  mkdirSync(proceduresDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  writeFileSync(
    join(proceduresDir, "proc-release-notes.md"),
    [
      "---",
      "kind: brain-procedure",
      "source_proposal: prop-release-notes",
      "triggers: [release, changelog]",
      "tags: [ops, docs]",
      "---",
      "# Release notes procedure",
    ].join("\n") + "\n",
    "utf8",
  );

  writeFileSync(
    join(skillsDir, "SKILL.md"),
    [
      "---",
      "version: 1",
      "triggers: [release]",
      "tags: [ops]",
      "permissions: [read]",
      "source: test-suite",
      "---",
      "# Release Skill",
    ].join("\n") + "\n",
    "utf8",
  );

  writeFileSync(
    ensureParent(skillProposalAcceptedPath(vaultPath, "release-notes")),
    [
      "---",
      "kind: brain-skill-proposal",
      "id: prop-release-notes",
      "slug: release-notes",
      "status: accepted",
      "pattern_kind: repeated_action",
      "---",
      "# Proposal release-notes",
    ].join("\n") + "\n",
    "utf8",
  );
}

function ensureParent(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
