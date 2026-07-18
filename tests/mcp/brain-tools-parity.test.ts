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
 * suite); the codegraph-and-MCP operational-readability release added
 * `brain_codegraph_report` (read-only codegraph partner report); the
 * Hindsight brain-loop ops release added `brain_generation_reports`
 * (inbound, opt-in LLM generation tracing); the calendar-integration
 * release added `brain_agenda` (deterministic agenda synthesis over
 * caller-provided events) and `brain_obligation` (recurring obligations
 * with a cadence-driven next-due date); the memory-subsystem-alignment
 * release added `brain_memory_bridge` (the Hermes on_memory_write host
 * bridge — persists native built-in-memory writes as durable
 * host_memory_write continuity records); the dashboard-context-trace
 * release added `brain_event_trace` (joins logged Brain events to the
 * continuity records attached to them by shared correlation ids); the
 * context-pack-economics-observability release added
 * `brain_route_metrics` (route-level MCP tool latency read over opt-in
 * `mcp_route_latency` continuity records) and `brain_token_impact` (durable
 * token-impact ledger: tokenizer-exact prompt-token deltas kept strictly
 * separate from a modeled, outcome-calibrated inference-avoidance estimate)
 * and `brain_context_pack_outcome` (agent-operable outcome loop: a compact
 * per-sample outcome row keeping the exact/modeled/observed token signals
 * strictly separate, composing the token-impact ledger's calibration); the
 * memory-signal-provenance-lifecycle release added `brain_ingest_batch_plan`
 * (deterministic large-folder ingest planner: skips unchanged sources via the
 * content-hash manifest and shards the remainder into size+count-bounded
 * batches for parallel-subagent dispatch).
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";

const FROZEN_BRAIN_TOOL_NAMES = [
  "brain_agenda",
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
  "brain_claims",
  "brain_clusters",
  "brain_codegraph_report",
  "brain_context",
  "brain_context_pack",
  "brain_context_pack_outcome",
  "brain_context_presets",
  "brain_context_receipts",
  "brain_create_note",
  "brain_dead_ends",
  "brain_decision",
  "brain_deep_synthesis",
  "brain_delete_by_source",
  "brain_derive_fact",
  "brain_distill_source",
  "brain_doctor",
  "brain_dream",
  "brain_entity",
  "brain_event_trace",
  "brain_feedback",
  "brain_foresight",
  "brain_generation_reports",
  "brain_health",
  "brain_hygiene",
  "brain_idea_discovery",
  "brain_idea_lineage",
  "brain_ingest_batch_plan",
  "brain_ingest_source",
  "brain_intake_entities",
  "brain_intent_review",
  "brain_intention",
  "brain_knowledge_gaps",
  "brain_labels",
  "brain_lifecycle",
  "brain_maintenance",
  "brain_mcp_landscape",
  "brain_memory_bridge",
  "brain_moc_audit",
  "brain_note",
  "brain_note_history",
  "brain_obligation",
  "brain_observed_use",
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
  "brain_route_metrics",
  "brain_search_by_source",
  "brain_secrets",
  "brain_session_checkpoint",
  "brain_session_describe",
  "brain_session_expand",
  "brain_session_grep",
  "brain_session_summary",
  "brain_skill_proposals",
  "brain_sources",
  "brain_stale_scan",
  "brain_switch_vault",
  "brain_tiers",
  "brain_token_impact",
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
