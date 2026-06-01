import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAttentionContextBlock,
  evaluateAttentionFlow,
  listAttentionFlows,
  renderAttentionFlow,
} from "../../../src/core/brain/attention-flows.ts";
import { applyRecurrenceEvidence } from "../../../src/core/brain/recurrence.ts";
import { reconcileProceduralMemory } from "../../../src/core/brain/procedural-memory.ts";
import { writeFrontmatterAtomic } from "../../../src/core/vault.ts";
import { skillProposalPendingPath } from "../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = join(
    tmpdir(),
    `o2b-attention-flows-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(vault, { recursive: true });
  seedSources(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("attention flow recipes", () => {
  test("lists default flow and evaluates deterministic sections", () => {
    const flows = listAttentionFlows(vault);
    expect(flows.length).toBeGreaterThan(0);

    const report = evaluateAttentionFlow(vault, flows[0]!.id);
    expect(report.sections.length).toBeGreaterThan(0);
    expect(renderAttentionFlow(vault, report.flow_id)).toContain("#");
  });

  test("builds context block for requested flow ids", () => {
    const flows = listAttentionFlows(vault);
    const block = buildAttentionContextBlock(vault, [flows[0]!.id]);
    expect(block).not.toBeNull();
    expect(block).toContain(flows[0]!.title);
  });
});

function seedSources(vaultPath: string): void {
  const proceduresDir = join(vaultPath, "Brain", "procedures");
  const skillsDir = join(vaultPath, "skills", "release");
  mkdirSync(proceduresDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  writeFileSync(
    join(proceduresDir, "proc-release-notes.md"),
    [
      "---",
      "kind: brain-procedure",
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

  reconcileProceduralMemory(vaultPath, {
    roots: [join(vaultPath, "Brain", "procedures"), join(vaultPath, "skills")],
  });

  writeFrontmatterAtomic(
    skillProposalPendingPath(vaultPath, "release-routine"),
    {
      kind: "brain-skill-proposal",
      id: "prop-release-routine",
      slug: "release-routine",
      status: "pending",
      pattern_kind: "repeated_action",
    },
    "# Proposal",
    {
      overwrite: false,
      existsErrorKind: "skill proposal",
      vaultForRelativePath: vaultPath,
    },
  );

  applyRecurrenceEvidence(vaultPath, {
    contentHash: "h-attn",
    scope: "project-a",
    sourceId: "src-1",
    action: "learn",
  });
  applyRecurrenceEvidence(vaultPath, {
    contentHash: "h-attn",
    scope: "project-b",
    sourceId: "src-2",
    action: "learn",
  });
  applyRecurrenceEvidence(vaultPath, {
    contentHash: "h-attn",
    scope: "project-c",
    sourceId: "src-3",
    action: "learn",
  });
}
