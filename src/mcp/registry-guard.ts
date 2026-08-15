/**
 * Registry guard (token-diet, t_352fd7f6 + t_c967abaf; completeness
 * audit added by evidence-at-the-boundary, task C3).
 *
 * One walk over the assembled tool table backs three contract tests:
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
 *   3. Schema completeness - the catalog documents itself. Fifty-nine
 *      advertised parameters carried no description at all when this
 *      audit was written; five further dimensions (object root, a
 *      properties map, a closed root, a declared type on every node, a
 *      `required` list naming only declared properties) were already
 *      clean at 108 of 108 tools and equally unguarded, so they ratchet
 *      here rather than wait for the first regression.
 *
 * Why one traversal rather than two. The original walker descended
 * `properties` and `items` and lost the difference between them, which
 * is precisely the difference a completeness rule needs: the array
 * property already carries the description, and demanding one on a
 * `{type:"string"}` items node produces 53 noise entries. So the walk is
 * now a node stream carrying node KIND, and both audits read it. Two
 * walks that disagreed about which nodes exist is the drift this
 * removes.
 *
 * Why {@link SCHEMA_COMPLETENESS_RULE.unsupportedComposition} exists with
 * no offender in the table: the walk follows `properties`, `items` and a
 * schema-valued `additionalProperties`, and nothing else. A `oneOf`, an
 * `allOf` or a `$ref` would be skipped in silence, and every rule below
 * it would pass by never running. Reporting the keyword turns a future
 * composed schema into a failing test instead of an unguarded one.
 *
 * There is deliberately NO exemption table for descriptions. An
 * exemption keyed on a property path would be a rule that documents
 * nothing; the fix for a missing description is the description.
 *
 * Test-time module: nothing here runs on the MCP request path. The
 * request-path counterpart is `./argument-guard.ts`, which reads the
 * `additionalProperties: false` this audit guarantees.
 */

import type { ToolDefinition } from "./tool-contract.ts";

export const TOOL_DESCRIPTION_MAX = 300;
export const PROPERTY_DESCRIPTION_MAX = 160;

/**
 * Shortest reason that can justify a preview-budget exemption. Sits with
 * the caps because it is the same kind of number: a floor under prose
 * that a reviewer has to read, not a style preference.
 */
export const EXEMPTION_REASON_MIN = 10;

/**
 * What kind of schema node the walk is standing on. The kind is the
 * whole point of the stream: `missing-description` applies to `property`
 * nodes and nothing else.
 */
export const SCHEMA_NODE_KIND = Object.freeze({
  /** The tool's input schema itself. */
  root: "root",
  /** Reached through a `properties` entry, so it has a name of its own. */
  property: "property",
  /** Reached through an `items` edge; the array property names it. */
  items: "items",
  /** Reached through a schema-valued `additionalProperties` (a free map). */
  values: "values",
} as const);

/** Closed union over {@link SCHEMA_NODE_KIND}. */
export type SchemaNodeKind = (typeof SCHEMA_NODE_KIND)[keyof typeof SCHEMA_NODE_KIND];

/** Membership list, in traversal-discovery order. */
export const SCHEMA_NODE_KINDS: ReadonlyArray<SchemaNodeKind> = Object.freeze([
  SCHEMA_NODE_KIND.root,
  SCHEMA_NODE_KIND.property,
  SCHEMA_NODE_KIND.items,
  SCHEMA_NODE_KIND.values,
]);

/** Narrow a string back to a member of the kind vocabulary. */
export function isSchemaNodeKind(value: unknown): value is SchemaNodeKind {
  return typeof value === "string" && (SCHEMA_NODE_KINDS as ReadonlyArray<string>).includes(value);
}

/** One node of one tool's input schema, as the walk found it. */
export interface SchemaNode {
  readonly tool: string;
  /** "" at the root, else a dotted path with `[]` and `{}` edge markers. */
  readonly path: string;
  readonly kind: SchemaNodeKind;
  /** The node object itself, for the audits to read. */
  readonly schema: Readonly<Record<string, unknown>>;
}

/**
 * Composition keywords the walk cannot follow. Not a style ban: each one
 * hides a subschema from every rule below it, so the honest answer is to
 * report it rather than descend into a branch this walker does not model.
 */
const UNSUPPORTED_COMPOSITION_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "oneOf",
  "anyOf",
  "allOf",
  "$ref",
]);

/** Depth-first node stream over one tool's input schema. */
export function* schemaNodes(tool: string, schema: unknown, path = ""): Generator<SchemaNode> {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as Record<string, unknown>;
  yield {
    tool,
    path,
    kind: path === "" ? SCHEMA_NODE_KIND.root : nodeKindFromPath(path),
    schema: node,
  };
  const properties = node["properties"];
  if (properties !== null && typeof properties === "object") {
    for (const key of Object.keys(properties)) {
      yield* schemaNodes(tool, (properties as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }
  if (node["items"] !== undefined) yield* schemaNodes(tool, node["items"], `${path}[]`);
  const additional = node["additionalProperties"];
  if (additional !== null && typeof additional === "object" && !Array.isArray(additional)) {
    yield* schemaNodes(tool, additional, `${path}{}`);
  }
}

/** The edge marker the path ends with names the kind that reached it. */
function nodeKindFromPath(path: string): SchemaNodeKind {
  if (path.endsWith("[]")) return SCHEMA_NODE_KIND.items;
  if (path.endsWith("{}")) return SCHEMA_NODE_KIND.values;
  return SCHEMA_NODE_KIND.property;
}

export interface DescriptionViolation {
  readonly tool: string;
  /** "" for the tool description itself, else the property path. */
  readonly path: string;
  readonly length: number;
  readonly limit: number;
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
    for (const node of schemaNodes(tool.name, tool.inputSchema)) {
      if (node.kind === SCHEMA_NODE_KIND.root) continue;
      const description = node.schema["description"];
      if (typeof description === "string" && description.length > PROPERTY_DESCRIPTION_MAX) {
        out.push({
          tool: tool.name,
          path: node.path,
          length: description.length,
          limit: PROPERTY_DESCRIPTION_MAX,
        });
      }
    }
  }
  return out;
}

/**
 * The closed vocabulary of completeness defects. Every entry names what
 * is missing, never a severity: a schema either says the thing or it
 * does not.
 */
export const SCHEMA_COMPLETENESS_RULE = Object.freeze({
  /** A named property advertises itself with no description. */
  missingDescription: "missing-description",
  /** A node declares neither a `type` nor an `enum`. */
  missingType: "missing-type",
  /** The root does not declare `additionalProperties: false`. */
  openRoot: "open-root",
  /** The root is not `type: "object"`. */
  nonObjectRoot: "non-object-root",
  /** The root carries no `properties` map, so it advertises no arguments. */
  missingProperties: "missing-properties",
  /** A `required` entry names a property the same node never declared. */
  undeclaredRequired: "undeclared-required",
  /** A composition keyword hides a subschema the walk cannot follow. */
  unsupportedComposition: "unsupported-composition",
} as const);

/** Closed union over {@link SCHEMA_COMPLETENESS_RULE}. */
export type SchemaCompletenessRule =
  (typeof SCHEMA_COMPLETENESS_RULE)[keyof typeof SCHEMA_COMPLETENESS_RULE];

/** Membership list, root-shape rules first. */
export const SCHEMA_COMPLETENESS_RULES: ReadonlyArray<SchemaCompletenessRule> = Object.freeze([
  SCHEMA_COMPLETENESS_RULE.nonObjectRoot,
  SCHEMA_COMPLETENESS_RULE.missingProperties,
  SCHEMA_COMPLETENESS_RULE.openRoot,
  SCHEMA_COMPLETENESS_RULE.missingDescription,
  SCHEMA_COMPLETENESS_RULE.missingType,
  SCHEMA_COMPLETENESS_RULE.undeclaredRequired,
  SCHEMA_COMPLETENESS_RULE.unsupportedComposition,
]);

/** Narrow a string back to a member of the rule vocabulary. */
export function isSchemaCompletenessRule(value: unknown): value is SchemaCompletenessRule {
  return (
    typeof value === "string" &&
    (SCHEMA_COMPLETENESS_RULES as ReadonlyArray<string>).includes(value)
  );
}

export interface CompletenessViolation {
  readonly tool: string;
  /** "" at the root, else the path of the offending node. */
  readonly path: string;
  readonly kind: SchemaNodeKind;
  readonly rule: SchemaCompletenessRule;
  /** What exactly is missing, when the rule alone does not say. */
  readonly detail: string;
}

/**
 * Every completeness defect across the advertised INPUT schemas.
 *
 * Output schemas are deliberately out of scope. Their vocabulary
 * declares union-typed fields with no `type` at all on purpose (the
 * lightweight response validator has no union, so `next_cursor` is
 * declared `{}` rather than declared wrongly), and not one of their 202
 * property nodes carries a description - `retrieval_trail` included.
 * Auditing them here would demand a type that would be a lie and turn a
 * 59-entry backfill into a 261-entry one. The output side already has
 * its own guard: every response is validated against its schema at
 * request time.
 */
export function auditSchemaCompleteness(
  tools: ReadonlyArray<ToolDefinition>,
): ReadonlyArray<CompletenessViolation> {
  const out: CompletenessViolation[] = [];
  for (const tool of tools) {
    for (const node of schemaNodes(tool.name, tool.inputSchema)) {
      auditNode(node, out);
    }
  }
  return Object.freeze(out);
}

function auditNode(node: SchemaNode, out: CompletenessViolation[]): void {
  const record = (rule: SchemaCompletenessRule, detail: string): void => {
    out.push({ tool: node.tool, path: node.path, kind: node.kind, rule, detail });
  };
  const schema = node.schema;

  for (const keyword of UNSUPPORTED_COMPOSITION_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      record(SCHEMA_COMPLETENESS_RULE.unsupportedComposition, keyword);
    }
  }
  // Tuple-form `items` is the same problem wearing a supported keyword:
  // the walk descends a single schema and would skip an array of them.
  if (Array.isArray(schema["items"])) {
    record(SCHEMA_COMPLETENESS_RULE.unsupportedComposition, "items[]");
  }

  const properties = schema["properties"];
  const hasProperties = properties !== null && typeof properties === "object";

  if (node.kind === SCHEMA_NODE_KIND.root) {
    if (schema["type"] !== "object") {
      record(SCHEMA_COMPLETENESS_RULE.nonObjectRoot, `type=${String(schema["type"])}`);
    }
    if (!hasProperties) record(SCHEMA_COMPLETENESS_RULE.missingProperties, "properties");
    if (schema["additionalProperties"] !== false) {
      record(SCHEMA_COMPLETENESS_RULE.openRoot, "additionalProperties");
    }
  }

  if (node.kind === SCHEMA_NODE_KIND.property) {
    const description = schema["description"];
    if (typeof description !== "string" || description.trim() === "") {
      record(SCHEMA_COMPLETENESS_RULE.missingDescription, "description");
    }
  }

  if (schema["type"] === undefined && schema["enum"] === undefined) {
    record(SCHEMA_COMPLETENESS_RULE.missingType, "type");
  }

  const required = schema["required"];
  if (Array.isArray(required)) {
    const declared = hasProperties ? new Set(Object.keys(properties)) : new Set<string>();
    for (const entry of required) {
      if (typeof entry !== "string" || !declared.has(entry)) {
        record(SCHEMA_COMPLETENESS_RULE.undeclaredRequired, String(entry));
      }
    }
  }
}

/** One line per violation, so a failing assertion names every offender. */
export function renderCompletenessViolations(
  violations: ReadonlyArray<CompletenessViolation>,
): string {
  return violations.map((v) => `${v.tool}${v.path} [${v.kind}] ${v.rule}: ${v.detail}`).join("\n");
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
  // The four note writers. Their receipts are no longer fixed-shape:
  // each carries an additive `lint` key over the pages it committed
  // (evidence-at-the-boundary, task A4). That key is what bounds them
  // now, and it bounds itself - the finding list is capped and reports
  // `total`, `returned` and `truncated`, so a preview envelope would
  // truncate a list that already declares its own truncation.
  brain_create_note:
    "write; returns the created note path, a created flag, the outcome discriminant, and a page-lint finding list capped and self-declaring its truncation",
  brain_update_note:
    "write; returns the updated note path, the kernel's updated flag, and a page-lint finding list capped and self-declaring its truncation",
  brain_append_note:
    "write; returns the appended note path, the kernel's appended flag, and a page-lint finding list capped and self-declaring its truncation",
  brain_write_batch:
    "write; returns a bounded per-operation result list, an applied count, and one page-lint finding list capped and self-declaring its truncation",
  brain_pinned_context: "pinned.md is operator-curated and small by practice",
  brain_recall_feedback: "write; returns one event receipt plus bounded weights",
  brain_switch_vault: "write; returns a small profile ack",
  brain_write_session: "lifecycle ops return one fixed-shape envelope; prompts are kernel-bounded",
  brain_intake_entities: "write; returns created/updated id lists and a relation count",
  brain_ingest_source: "write; returns the summary path plus bounded id lists",
  brain_distill_source: "write; returns the distillation path plus a claim count and source hash",
  brain_research_report: "write; returns the report path and a finding count",
  brain_derive_fact: "write; returns one derived preference id, its level and premises",
  brain_memory_bridge:
    "write; returns a small fixed-shape receipt (recorded flag, kind, count, ids)",

  // Bounded by the operator-curated schema block, not by a receipt. Under
  // `dry_run: true` this tool is not a write at all and returns no receipt:
  // it returns the entire resulting pack plus a leaf-level diff.
  schema_apply_mutations:
    "returns the whole resulting schema pack - plus a leaf diff under dry_run, which writes nothing; bounded by the size of the schema block in Brain/_brain.yaml, which the operator curates",

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
