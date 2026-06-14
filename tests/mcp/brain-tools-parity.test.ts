/**
 * Frozen-surface parity guard for the Brain MCP tool set.
 *
 * v1.0.0 froze the public MCP surface; this test pins the exact tool
 * names BRAIN_TOOLS advertises so the per-domain module split (and any
 * future registry change) is provably name-set-preserving. A failure
 * here means the public surface changed - that requires a deliberate
 * major/minor release decision, not a refactor.
 *
 * Deliberate surface changes so far: v1.3.0 added `brain_hygiene` and
 * `brain_anticipatory_context` (continuity-hygiene-freshness suite); v1.7.0
 * added `brain_intake_entities`, `brain_ingest_source`,
 * `brain_research_report`, and `brain_derive_fact` (Knowledge Provenance
 * suite).
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";

const FROZEN_BRAIN_TOOL_NAMES = [
  "brain_agent_diff",
  "brain_agent_query",
  "brain_analytics",
  "brain_anticipatory_context",
  "brain_apply_evidence",
  "brain_audit",
  "brain_backlinks",
  "brain_benchmark",
  "brain_bridges",
  "brain_brief",
  "brain_clusters",
  "brain_context",
  "brain_context_pack",
  "brain_context_presets",
  "brain_context_receipts",
  "brain_create_note",
  "brain_dead_ends",
  "brain_deep_synthesis",
  "brain_derive_fact",
  "brain_doctor",
  "brain_dream",
  "brain_entity",
  "brain_feedback",
  "brain_foresight",
  "brain_health",
  "brain_hygiene",
  "brain_idea_discovery",
  "brain_idea_lineage",
  "brain_ingest_source",
  "brain_intake_entities",
  "brain_intent_review",
  "brain_intention",
  "brain_labels",
  "brain_maintenance",
  "brain_mcp_landscape",
  "brain_moc_audit",
  "brain_note",
  "brain_pinned_context",
  "brain_pre_compact_extract",
  "brain_pre_compress_pack",
  "brain_procedural_graph",
  "brain_procedural_memory",
  "brain_query",
  "brain_recall_telemetry",
  "brain_recurrence",
  "brain_research_report",
  "brain_retention",
  "brain_review_candidates",
  "brain_secrets",
  "brain_session_describe",
  "brain_session_expand",
  "brain_session_grep",
  "brain_session_summary",
  "brain_skill_proposals",
  "brain_sources",
  "brain_stale_scan",
  "brain_switch_vault",
  "brain_tiers",
  "brain_trigger",
  "brain_truth",
  "brain_tune",
  "brain_unlinked_mentions",
  "brain_write_session",
] as const;

describe("BRAIN_TOOLS frozen surface", () => {
  test("advertises exactly the v1.x tool-name set", () => {
    const names = BRAIN_TOOLS.map((t) => t.name).toSorted();
    expect(names).toEqual([...FROZEN_BRAIN_TOOL_NAMES]);
  });

  test("has no duplicate tool names", () => {
    const names = BRAIN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool carries a handler and an input schema", () => {
    for (const tool of BRAIN_TOOLS) {
      expect(typeof tool.handler).toBe("function");
      expect(tool.inputSchema).toBeDefined();
    }
  });
});
