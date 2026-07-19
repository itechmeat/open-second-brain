/**
 * `brain_deep_synthesis` MCP tool (Workspace Insight Suite, t_04e94382).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { listTriggers } from "../../src/core/brain/triggers/store.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { writeMd } from "../helpers/search-fixtures.ts";

let tmp: string;
let vault: string;
let ctx: ServerContext;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-synth-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  writeMd(
    vault,
    "Brain/notes/claim.md",
    "---\ncontradicts: [[counter]]\n---\n# Claim\n\nWyverns roost in cliffs. See [[lost-note]].",
  );
  writeMd(vault, "Brain/notes/counter.md", "# Counter\n\nWyverns roost in forests.");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("returns the dossier and optionally enqueues triggers", async () => {
  const tool = findTool(buildToolTable("full"), "brain_deep_synthesis");
  const report = (await tool.handler(ctx, { topic: "wyverns", triggers: true })) as {
    checked: string[];
    contradictions: Array<{ target: string }>;
    gaps: Array<{ target: string }>;
    strongest_objection: { basis: string; statement: string; source_artifacts: string[] } | null;
    triggers_created: number;
  };
  expect(report.checked).toContain("knowledge_gaps");
  expect(report.checked).toContain("strongest_objection");
  expect(report.contradictions[0]!.target).toBe("counter");
  expect(report.gaps[0]!.target).toBe("lost-note");
  expect(report.strongest_objection).not.toBeNull();
  expect(report.strongest_objection!.basis).toBe("contradiction");
  expect(report.strongest_objection!.source_artifacts).toContain("[[counter]]");
  expect(report.triggers_created).toBeGreaterThanOrEqual(2);
  expect(listTriggers(vault, { now: new Date() }).length).toBe(report.triggers_created);
});

test("exposes causal context, decomposed confidence, and exclusions (t_40fa4e8d)", async () => {
  const tool = findTool(buildToolTable("full"), "brain_deep_synthesis");
  const report = (await tool.handler(ctx, { topic: "wyverns" })) as {
    findings: Array<{
      evidence: { path: string; kind: string; content_hash: string };
      title: string | null;
      causal_context: {
        relations: Array<{ relation: string; target: string }>;
        superseded_by: string | null;
        dangling_citations: number;
      };
      confidence: { support: number; opposition: number; freshness: number; coverage: number };
    }>;
    excluded_findings: Array<{ path: string; reason: string }>;
    excluded_finding_count: number;
  };
  expect(Array.isArray(report.findings)).toBe(true);
  const claim = report.findings.find((f) => f.evidence.path === "Brain/notes/claim.md");
  expect(claim).toBeDefined();
  expect(claim!.evidence.kind).toBe("note");
  expect(claim!.evidence.content_hash).toMatch(/^[0-9a-f]{64}$/);
  // claim.md contradicts counter, so opposition is decomposed out.
  expect(claim!.confidence.opposition).toBeGreaterThanOrEqual(1);
  expect(typeof claim!.confidence.support).toBe("number");
  expect(typeof claim!.confidence.freshness).toBe("number");
  expect(typeof claim!.confidence.coverage).toBe("number");
  // The dangling [[lost-note]] citation is recorded as causal context.
  expect(claim!.causal_context.dangling_citations).toBeGreaterThanOrEqual(1);
  expect(claim!.causal_context.relations.some((r) => r.relation === "contradicts")).toBe(true);
  // Evidence loss is visible, never silent.
  expect(Array.isArray(report.excluded_findings)).toBe(true);
  expect(typeof report.excluded_finding_count).toBe("number");
  expect(report.excluded_finding_count).toBe(report.excluded_findings.length);
});

test("rejects a missing topic", async () => {
  const tool = findTool(buildToolTable("full"), "brain_deep_synthesis");
  // The handler is async: assert the rejected promise, not a sync throw.
  await expect(Promise.resolve(tool.handler(ctx, {}))).rejects.toThrow();
});
