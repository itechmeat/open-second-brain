/**
 * `brain_diarize` MCP tool (subject diarization, t_28ba3fc4).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let ctx: ServerContext;
const NOW = new Date("2026-07-19T10:00:00Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-diarize-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  upsertEntity(vault, {
    category: "person",
    name: "Ada Lovelace",
    agent: "test",
    now: NOW,
    body: "Ada Lovelace designed an early programming method for the analytical engine.",
  });
  const sources = join(vault, "Brain", "sources");
  mkdirSync(sources, { recursive: true });
  writeFileSync(
    join(sources, "src-lecture.md"),
    [
      "---",
      "kind: brain-source",
      "source_path: lecture.txt",
      "created_at: 2026-07-10T00:00:00Z",
      "updated_at: 2026-07-10T00:00:00Z",
      "---",
      "",
      "Ada Lovelace attended a lecture on analytical engines.",
      "",
    ].join("\n"),
  );
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("returns the profile skeleton, gap section, and needs-llm-step envelope", async () => {
  const tool = findTool(buildToolTable("full"), "brain_diarize");
  const report = (await tool.handler(ctx, { entity: "Ada Lovelace" })) as {
    entity_id: string;
    stated_vs_evidenced: Array<{ kind: string; evidence: { kind: string } }>;
    skeleton: string;
    llm_step: { status: string; step: string; target_path: string };
  };
  expect(report.entity_id).toContain("ent-person");
  expect(report.stated_vs_evidenced.length).toBeGreaterThanOrEqual(1);
  expect(report.stated_vs_evidenced[0]!.evidence.kind).toBe("claim");
  expect(report.skeleton).toContain("kind: brain-profile");
  expect(report.llm_step.status).toBe("needs-llm-step");
  expect(report.llm_step.step).toBe("profile-prose");
});

test("rejects an unknown entity", async () => {
  const tool = findTool(buildToolTable("full"), "brain_diarize");
  await expect(Promise.resolve(tool.handler(ctx, { entity: "Nobody At All" }))).rejects.toThrow();
});

test("is a full-tier tool, absent from the writer surface", () => {
  expect(buildToolTable("full").find((t) => t.name === "brain_diarize")).toBeDefined();
  expect(buildToolTable("writer").find((t) => t.name === "brain_diarize")).toBeUndefined();
});
