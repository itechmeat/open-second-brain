/**
 * Public surfaces removed at a major version (1.0.0 deprecation
 * sweep, epic t_a77ade0a). One canonical map serves two consumers:
 *
 *   - the MCP server answers `tools/call` on a removed name with an
 *     INVALID_PARAMS tombstone naming the replacement
 *     (src/mcp/tools.ts `findTool`);
 *   - `brain_doctor` scans vault-side text surfaces (Brain notes,
 *     root instruction files, installed skills) for stale references
 *     and warns with the same replacement
 *     (src/core/brain/doctor.ts).
 *
 * Lives in core (not src/mcp/) so the doctor never imports the MCP
 * layer.
 */

export interface RemovedToolRecord {
  /** Version that removed the surface, e.g. "1.0.0". */
  readonly removedIn: string;
  /** Consolidated tool that replaced it. */
  readonly target: string;
  /** `view` argument value selecting the predecessor's behavior. */
  readonly view: string;
}

/** The 18 token-diet aliases deleted in 1.0.0. */
export const REMOVED_TOOLS: Readonly<Record<string, RemovedToolRecord>> = Object.freeze({
  brain_digest: { removedIn: "1.0.0", target: "brain_brief", view: "digest" },
  brain_daily_brief: { removedIn: "1.0.0", target: "brain_brief", view: "daily" },
  brain_morning_brief: { removedIn: "1.0.0", target: "brain_brief", view: "morning" },
  brain_weekly_synthesis: { removedIn: "1.0.0", target: "brain_brief", view: "weekly" },
  brain_monthly_review: { removedIn: "1.0.0", target: "brain_brief", view: "monthly" },
  brain_operator_summary: { removedIn: "1.0.0", target: "brain_brief", view: "operator" },
  brain_attention_flows: {
    removedIn: "1.0.0",
    target: "brain_analytics",
    view: "attention_flows",
  },
  brain_concept_synthesis: {
    removedIn: "1.0.0",
    target: "brain_analytics",
    view: "concept_synthesis",
  },
  brain_timeline: { removedIn: "1.0.0", target: "brain_analytics", view: "timeline" },
  brain_belief_evolution: {
    removedIn: "1.0.0",
    target: "brain_analytics",
    view: "belief_evolution",
  },
  get_active_schema_pack: { removedIn: "1.0.0", target: "schema_inspect", view: "active_pack" },
  list_schema_packs: { removedIn: "1.0.0", target: "schema_inspect", view: "packs" },
  schema_stats: { removedIn: "1.0.0", target: "schema_inspect", view: "stats" },
  schema_lint: { removedIn: "1.0.0", target: "schema_inspect", view: "lint" },
  schema_graph: { removedIn: "1.0.0", target: "schema_inspect", view: "graph" },
  schema_explain_type: { removedIn: "1.0.0", target: "schema_inspect", view: "explain_type" },
  schema_review_orphans: { removedIn: "1.0.0", target: "schema_inspect", view: "orphans" },
  reload_schema_pack: { removedIn: "1.0.0", target: "schema_inspect", view: "active_pack" },
});

/** `name -> replacement` rendered the way tombstone errors phrase it. */
export function removedToolReplacement(name: string): string | null {
  const record = REMOVED_TOOLS[name];
  if (record === undefined) return null;
  return `${record.target} with view="${record.view}"`;
}
