/**
 * The calls of the registry-wide read probe
 * (`lane-private-partition-reach-probe.test.ts`), built from each tool's
 * input schema: the read verbs of every tool, once with no entry and once
 * per seeded entry for a verb that names one, and the operations a view
 * runs under a key of its own. Moved out of the probe so it stays a
 * readable size (change `lane-reach-residuals`, package 18).
 */

import type { ToolDefinition } from "../../src/mcp/tool-contract.ts";
import { isListOrCountCall } from "./lane-private-partition-reach-probe-counts.ts";
import type { SeededEntry, WriterRow } from "./lane-private-partition-reach-probe-writers.ts";

/** A word every seeded entry carries, so a search finds them all. */
export const COMMON = "zqcommonword";

export interface Seeded {
  /** The lane, as the report names it. */
  readonly lane: string;
  readonly by: "writer" | "writeLaneText";
  readonly hidden: SeededEntry;
  readonly shared: SeededEntry;
  /** The lane's own reader, for a lane seeded by its writer. */
  readonly reader?: WriterRow["reader"];
}

// ----- The calls, from the registry ----------------------------------------------------

const ACTION_KEYS = ["action", "operation", "op", "view", "mode"] as const;
/**
 * The verbs of a write-kind tool that only read. A verb name, not a lane:
 * every other verb of a write tool is skipped and named in the output.
 */
const READ_VERBS = new Set([
  "list",
  "show",
  "get",
  "status",
  "history",
  "hints",
  "summary",
  "current",
  "at",
  "replaced",
  "contests",
  "conflicts",
  "slots",
  "aggregate",
  "collisions",
  "events",
  "state",
  "list_open",
  "show_open",
  "compare",
  "similar",
  "recall",
  "read",
  "usage",
  "evidence",
  "page_candidates",
  "scan",
  "check",
  "verify",
  "morning",
  "daily",
  "weekly",
  "monthly",
  "operator",
  "digest",
  "today",
  "timeline",
  "attention_flows",
  "belief_evolution",
  "concept_synthesis",
  "dedup",
  "suggest",
  "gate_list",
  "gate_summary",
]);
/**
 * The read verbs that list rather than name one entry: called once, with
 * no per-lane argument (an id, path or title passed to them names nothing).
 */
const LIST_VERBS = new Set([
  "list",
  "list_open",
  "summary",
  "aggregate",
  "collisions",
  "slots",
  "events",
  "state",
  "hints",
  "morning",
  "daily",
  "weekly",
  "monthly",
  "operator",
  "digest",
  "today",
  "timeline",
  "attention_flows",
  "belief_evolution",
  "concept_synthesis",
  "gate_list",
  "gate_summary",
]);
/** Write tools with no verb whose call with no write argument only reads. */
const READ_ONLY_CALLS = new Set([
  "brain_context",
  "brain_doctor",
  "brain_idea_discovery",
  "brain_search",
]);
const QUERY_PROPS = new Set([
  "query",
  "q",
  "pattern",
  "prompt",
  "question",
  "topic",
  "focus_query",
]);
const ID_PROPS = new Set([
  "id",
  "slug",
  "slugs",
  "pref_id",
  "chunk_id",
  "artifact_id",
  "content_hash",
  "session_id",
  "skill_name",
  "entity",
  "scope",
  "name",
  "subject",
  "flow_id",
  "preset_id",
  "target",
]);
const PATH_PROPS = new Set(["path", "file_path", "source_file", "source", "page", "artifact"]);

/**
 * Verbs that read none of the per-lane arguments, from the tools' code, so
 * their per-lane calls would repeat the call without them: `brain_trigger`
 * scan and history (`workspace-tools.ts`: only a transition reads `id`),
 * and `brain_agent_diff` modes other than search (`agent-source/diff.ts`:
 * `mode` labels one `queryAgentSources` read of the same topic and query,
 * so the search mode's per-lane calls stand for every mode). A tool with
 * no verb is keyed by `(no verb)`: `brain_search_by_source` answers the
 * pages an ingest derived from `source_file` (`ingest-source-tools.ts`),
 * and no seeded lane entry is an ingest source, so its per-lane calls
 * repeat the absent-source call.
 */
const NO_ENTRY_ARGS: Readonly<Record<string, ReadonlySet<string>>> = {
  brain_trigger: new Set(["scan", "history"]),
  brain_agent_diff: new Set(["browse", "diff", "map"]),
  brain_search_by_source: new Set(["(no verb)"]),
};

export interface Plan {
  readonly tool: string;
  readonly calls: Array<{
    readonly args: Record<string, unknown>;
    readonly seeded?: Seeded;
    /** `<tool> <verb>`, the verb as the count comparison names it. */
    readonly call: string;
    /** A list or count call: compared with the shared-only twin. */
    readonly listing: boolean;
  }>;
  readonly skipped: string[];
}

/**
 * Operations a view runs under an optional key of its own, called like a
 * verb that names one entry (with no entry, then per seeded entry): the
 * attention flows' `evaluate` and `render` (`analytics-tools.ts`, view
 * `attention_flows`).
 */
const SUB_OPERATIONS: Readonly<
  Record<
    string,
    { readonly view: string; readonly key: string; readonly operations: ReadonlyArray<string> }
  >
> = {
  brain_analytics: {
    view: "attention_flows",
    key: "operation",
    operations: ["evaluate", "render"],
  },
};

function schemaOf(tool: ToolDefinition): {
  props: Record<string, { type?: string; enum?: unknown[]; items?: unknown }>;
  required: string[];
} {
  const s = (tool.inputSchema ?? {}) as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
  };
  return { props: s.properties ?? {}, required: s.required ?? [] };
}

function valueFor(
  prop: string,
  spec: { type?: string },
  seeded: Seeded | undefined,
): unknown | undefined {
  const asType = (v: string): unknown => (spec.type === "array" ? [v] : v);
  if (QUERY_PROPS.has(prop)) return asType(seeded === undefined ? COMMON : seeded.hidden.title);
  if (ID_PROPS.has(prop))
    return asType(seeded === undefined ? "probe-absent-id" : seeded.hidden.id);
  if (PATH_PROPS.has(prop))
    return asType(seeded === undefined ? "Brain/probe-absent.md" : seeded.hidden.rel);
  if (prop === "events") return [];
  return undefined;
}

export function planFor(tool: ToolDefinition, seeded: ReadonlyArray<Seeded>): Plan {
  const { props, required } = schemaOf(tool);
  // A required verb key wins (brain_analytics: `view` is required, its
  // `operation` qualifies one view only).
  const actionKey =
    ACTION_KEYS.find((k) => Array.isArray(props[k]?.enum) && required.includes(k)) ??
    ACTION_KEYS.find((k) => Array.isArray(props[k]?.enum));
  const skipped: string[] = [];
  let verbs: Array<string | undefined> = [undefined];
  if (actionKey !== undefined) {
    const all = props[actionKey]!.enum as string[];
    verbs = tool.kind === "write" ? all.filter((v) => READ_VERBS.has(v)) : all;
    for (const v of all) if (!verbs.includes(v)) skipped.push(`${actionKey}=${v}: write verb`);
  } else if (tool.kind === "write" && !READ_ONLY_CALLS.has(tool.name)) {
    return { tool: tool.name, calls: [], skipped: ["write tool with no read verb"] };
  }
  const idLike = Object.keys(props).filter(
    (p) => QUERY_PROPS.has(p) || ID_PROPS.has(p) || PATH_PROPS.has(p),
  );
  const calls: Plan["calls"] = [];
  for (const verb of verbs) {
    const base: Record<string, unknown> = {};
    if (actionKey !== undefined) base[actionKey] = verb;
    let missing: string | null = null;
    for (const req of required) {
      if (req === actionKey) continue;
      const v = valueFor(req, props[req] ?? {}, undefined);
      if (v === undefined) missing = req;
      else base[req] = v;
    }
    const label = verb === undefined ? "(no verb)" : `${actionKey}=${verb}`;
    if (missing !== null) {
      skipped.push(`${label}: required '${missing}' has no sensible probe value`);
      continue;
    }
    if ("dry_run" in props) base["dry_run"] = true;
    const call = `${tool.name} ${verb ?? "(no verb)"}`;
    calls.push({ args: base, call, listing: isListOrCountCall(tool.kind, verb ?? "(no verb)") });
    const namesNone =
      NO_ENTRY_ARGS[tool.name]?.has(verb ?? "(no verb)") === true ||
      (verb !== undefined && LIST_VERBS.has(verb));
    if (idLike.length === 0 || namesNone) continue;
    for (const s of seeded) {
      const args = { ...base };
      for (const p of idLike) args[p] = valueFor(p, props[p] ?? {}, s);
      calls.push({ args, seeded: s, call, listing: false });
    }
  }
  const sub = SUB_OPERATIONS[tool.name];
  if (sub !== undefined && actionKey !== undefined) {
    for (const operation of sub.operations) {
      const base: Record<string, unknown> = { [actionKey]: sub.view, [sub.key]: operation };
      const call = `${tool.name} ${sub.view} ${sub.key}=${operation}`;
      for (const s of [undefined, ...seeded]) {
        const args = { ...base };
        for (const p of idLike) {
          if (p in props) args[p] = valueFor(p, props[p] ?? {}, s);
        }
        calls.push({ args, ...(s !== undefined ? { seeded: s } : {}), call, listing: false });
      }
    }
  }
  return { tool: tool.name, calls, skipped };
}
