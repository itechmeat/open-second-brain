/**
 * Registry guard (token-diet, t_352fd7f6 + t_c967abaf).
 *
 * One walk over the assembled tool table backs two contract tests:
 *
 *   1. Description caps - tool descriptions and per-property schema
 *      descriptions have hard character ceilings so the serialized
 *      registry (paid by every MCP client on every request in
 *      non-deferred hosts) cannot silently regrow. Long-form guidance
 *      belongs in server instructions or docs/mcp.md, not in schemas.
 *   2. Preview-budget default - every tool either carries a
 *      `previewBudget` or appears in the explicit exempt list below
 *      with a reason. Unbounded tool output is a deliberate, reviewed
 *      property, never an accident of omission.
 *
 * Test-time module: nothing here runs on the MCP request path.
 */

import type { ToolDefinition } from "./tool-contract.ts";

export const TOOL_DESCRIPTION_MAX = 300;
export const PROPERTY_DESCRIPTION_MAX = 160;

export interface DescriptionViolation {
  readonly tool: string;
  /** "" for the tool description itself, else the property path. */
  readonly path: string;
  readonly length: number;
  readonly limit: number;
}

function walkSchema(
  tool: string,
  schema: unknown,
  path: string,
  out: DescriptionViolation[],
): void {
  if (schema === null || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  const description = node["description"];
  if (
    path !== "" &&
    typeof description === "string" &&
    description.length > PROPERTY_DESCRIPTION_MAX
  ) {
    out.push({ tool, path, length: description.length, limit: PROPERTY_DESCRIPTION_MAX });
  }
  const properties = node["properties"];
  if (properties !== null && typeof properties === "object") {
    for (const [key, child] of Object.entries(properties)) {
      walkSchema(tool, child, `${path}.${key}`, out);
    }
  }
  if (node["items"] !== undefined) walkSchema(tool, node["items"], `${path}[]`, out);
}

/** Every description over its cap, tool-level and property-level. */
export function auditToolDescriptions(
  tools: ReadonlyArray<ToolDefinition>,
): DescriptionViolation[] {
  const out: DescriptionViolation[] = [];
  for (const tool of tools) {
    if (tool.description.length > TOOL_DESCRIPTION_MAX) {
      out.push({
        tool: tool.name,
        path: "",
        length: tool.description.length,
        limit: TOOL_DESCRIPTION_MAX,
      });
    }
    walkSchema(tool.name, tool.inputSchema, "", out);
  }
  return out;
}

/**
 * Tools deliberately running without a preview budget, each with the
 * reason the omission is safe. Grouped by the property that bounds
 * their output instead.
 */
export const PREVIEW_BUDGET_EXEMPT: Readonly<Record<string, string>> = Object.freeze({
  // Writers and small acks - the result is a fixed-shape receipt.
  brain_feedback: "write; returns a small fixed-shape ack",
  brain_apply_evidence: "write; returns a small fixed-shape ack",
  brain_note: "write; returns a small fixed-shape ack",
  brain_observed_use: "write; returns a small fixed-shape ack (records/aggregates count)",
  brain_create_note: "write; returns the created note path and a created flag",
  brain_update_note: "write; returns the updated note path and an updated flag",
  brain_append_note: "write; returns the appended note path and an appended flag",
  brain_write_batch: "write; returns a bounded per-operation result list and an applied count",
  brain_pinned_context: "pinned.md is operator-curated and small by practice",
  brain_recall_feedback: "write; returns one event receipt plus bounded weights",
  brain_switch_vault: "write; returns a small profile ack",
  brain_write_session: "lifecycle ops return one fixed-shape envelope; prompts are kernel-bounded",
  schema_apply_mutations: "write; returns a bounded mutation receipt",
  brain_intake_entities: "write; returns created/updated id lists and a relation count",
  brain_ingest_source: "write; returns the summary path plus bounded id lists",
  brain_distill_source: "write; returns the distillation path plus a claim count and source hash",
  brain_research_report: "write; returns the report path and a finding count",
  brain_derive_fact: "write; returns one derived preference id, its level and premises",
  brain_memory_bridge:
    "write; returns a small fixed-shape receipt (recorded flag, kind, count, ids)",

  // Bounded-by-construction reads.
  second_brain_capabilities: "fixed-size capability report",
  second_brain_status:
    "diagnostic contract; callers need full brain/search/config blocks, not a preview envelope",
  brain_context:
    "session bootstrap; deliberately returns the full preference set - it is the full-view target the budgeted SessionStart injection points at",
  brain_pre_compress_pack: "self-budgeting; enforces its own char budget internally",
  brain_artifact_get: "the preview-budget escape hatch; truncating it would defeat itself",
  brain_health: "fixed-shape counters",
  brain_doctor: "issue list bounded by vault invariants; CLI surface renders full detail",
  brain_status: "bounded operator snapshot: fixed counts plus a short problem list with hints",
  brain_recall_gate: "single verdict object",
  vault_health: "fixed list of manifest checks",
  brain_watchdog: "bounded probe report",
  brain_dream: "returns pass counters, not content",
  brain_intent_review: "bounded review window summary",
  brain_retention: "bounded retention counters",
  brain_review_candidates: "dry-run counters and short id lists",
  brain_sources: "per-(agent, source_type) counts only",
  brain_stale_scan: "bounded staleness list with caps in the handler",
  brain_moc_audit: "bounded audit summary",
  brain_mcp_landscape: "fixed-shape landscape summary",
  brain_session_describe: "single-session metadata only",
  brain_context_receipts: "bounded receipt list per session",
  brain_event_trace: "bounded event→trace join summary; full records via per-kind readers",
  brain_context_presets: "small preset list",
  brain_pre_compact_extract: "bounded extract; host injects it whole by design",
  brain_skill_proposals: "bounded proposal list",
  brain_procedural_memory: "bounded hint list",
  brain_procedural_graph: "bounded graph summary",
  brain_recurrence: "bounded recurrence records; learn/forget are writes",
  brain_agent_diff: "bounded two-agent comparison",
  get_skill: "explicit full-content fetch; truncating the skill the agent asked for defeats it",
  tool_hydrate: "the two-pass schema escape hatch; truncating hydration would defeat itself",
  // The deprecated-alias exemptions were dropped with the aliases
  // themselves in the 1.0.0 sweep (tombstones in REMOVED_TOOLS).
});

/**
 * Own-key membership set for {@link PREVIEW_BUDGET_EXEMPT}, computed once at
 * module load. Replaces `name in PREVIEW_BUDGET_EXEMPT`, which walks the
 * prototype chain (so a tool named like an `Object.prototype` member -
 * `constructor`, `toString`, `hasOwnProperty` - would be falsely treated as
 * exempt) and recomputed `Object.keys` on every call. (t_6fbdba4b)
 */
const PREVIEW_BUDGET_EXEMPT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(PREVIEW_BUDGET_EXEMPT),
);

export interface PreviewBudgetAudit {
  /** Tools with neither a budget nor an exempt entry - the guard fails on these. */
  readonly unbudgetedAndUnexempted: ReadonlyArray<string>;
  /** Exempt entries that now carry a budget - stale exemptions to clean up. */
  readonly exemptButBudgeted: ReadonlyArray<string>;
  /** Exempt entries naming tools that no longer exist. */
  readonly exemptButUnknown: ReadonlyArray<string>;
}

export function auditPreviewBudgets(tools: ReadonlyArray<ToolDefinition>): PreviewBudgetAudit {
  const names = new Set(tools.map((t) => t.name));
  const unbudgetedAndUnexempted: string[] = [];
  const exemptButBudgeted: string[] = [];
  for (const tool of tools) {
    const exempt = PREVIEW_BUDGET_EXEMPT_NAMES.has(tool.name);
    if (tool.previewBudget === undefined && !exempt) unbudgetedAndUnexempted.push(tool.name);
    if (tool.previewBudget !== undefined && exempt) exemptButBudgeted.push(tool.name);
  }
  const exemptButUnknown = [...PREVIEW_BUDGET_EXEMPT_NAMES].filter((n) => !names.has(n));
  return Object.freeze({
    unbudgetedAndUnexempted: Object.freeze(unbudgetedAndUnexempted),
    exemptButBudgeted: Object.freeze(exemptButBudgeted),
    exemptButUnknown: Object.freeze(exemptButUnknown),
  });
}
