/**
 * Registry guard (token-diet, t_352fd7f6 + t_c967abaf): the serialized
 * tool registry is paid by every MCP client on every request in
 * non-deferred hosts, so description growth and unbounded outputs are
 * contract violations, not style issues.
 */

import { describe, expect, test } from "bun:test";

import {
  auditPreviewBudgets,
  auditSchemaCompleteness,
  auditToolDescriptions,
  EXEMPTION_REASON_MIN,
  PREVIEW_BUDGET_EXEMPT,
  renderCompletenessViolations,
  SCHEMA_COMPLETENESS_RULE,
  SCHEMA_COMPLETENESS_RULES,
  SCHEMA_NODE_KIND,
  schemaNodes,
} from "../../src/mcp/registry-guard.ts";
import type { ToolDefinition } from "../../src/mcp/tool-contract.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

const TOOLS = buildToolTable("full");

/** A one-off tool definition for the negative tests. */
function fakeTool(name: string, inputSchema: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: "A hand-built tool that exists only inside this test.",
    inputSchema,
    handler: async () => ({}),
  } as unknown as ToolDefinition;
}

/** The rules a hand-built schema tripped, deduplicated. */
function rulesOf(tool: ToolDefinition): ReadonlyArray<string> {
  return [...new Set(auditSchemaCompleteness([tool]).map((v) => v.rule))].toSorted();
}

describe("description caps", () => {
  test("no tool or property description exceeds its cap", () => {
    const violations = auditToolDescriptions(TOOLS);
    const rendered = violations
      .map((v) => `${v.tool}${v.path} (${v.length} > ${v.limit})`)
      .join("\n");
    expect(rendered).toBe("");
  });
});

describe("preview-budget default", () => {
  test("every tool carries a budget or an explicit exempt entry with a reason", () => {
    const audit = auditPreviewBudgets(TOOLS);
    expect(audit.unbudgetedAndUnexempted).toEqual([]);
  });

  test("no stale exemptions: exempt tools must stay budget-less and must exist", () => {
    const audit = auditPreviewBudgets(TOOLS);
    expect(audit.exemptButBudgeted).toEqual([]);
    expect(audit.exemptButUnknown).toEqual([]);
  });

  test("every exemption states a non-empty reason", () => {
    for (const [name, reason] of Object.entries(PREVIEW_BUDGET_EXEMPT)) {
      expect(reason.trim().length, name).toBeGreaterThan(EXEMPTION_REASON_MIN);
    }
  });

  test("a tool named like an Object.prototype member is not falsely exempt (t_6fbdba4b)", () => {
    // The exempt membership test must be own-key only: `name in EXEMPT` walks
    // the prototype chain, so a budget-less tool named "toString" (or
    // "constructor", "hasOwnProperty", ...) would be wrongly treated as exempt
    // and silently escape the unbudgeted-output guard.
    const tool = {
      name: "toString",
      description: "x",
      inputSchema: { type: "object" },
    } as unknown as (typeof TOOLS)[number];
    const audit = auditPreviewBudgets([tool]);
    expect(audit.unbudgetedAndUnexempted).toContain("toString");
  });
});

/**
 * evidence-at-the-boundary, task A4. The four note-write tools were
 * exempted with reasons reading "small fixed-shape receipt". They now
 * carry an additive `lint` key whose finding list is bounded and declares
 * its own truncation, so the reason has to state THAT rather than a
 * fixed shape it no longer has.
 */
describe("the write-tool exemptions state what actually bounds them", () => {
  const LINTED_WRITE_TOOLS = [
    "brain_create_note",
    "brain_update_note",
    "brain_append_note",
    "brain_write_batch",
  ];

  test("each names the bounded, truncation-declaring finding list", () => {
    for (const name of LINTED_WRITE_TOOLS) {
      const reason = PREVIEW_BUDGET_EXEMPT[name];
      expect(reason, name).toBeDefined();
      expect(reason!.toLowerCase(), name).toContain("truncat");
      expect(reason!.toLowerCase(), name).toContain("lint");
    }
  });

  test("none still claims a fixed-shape receipt", () => {
    for (const name of LINTED_WRITE_TOOLS) {
      expect(PREVIEW_BUDGET_EXEMPT[name]!.toLowerCase(), name).not.toContain("fixed-shape");
    }
  });
});

/**
 * Schema completeness (evidence-at-the-boundary, task C3).
 *
 * Fifty-nine advertised parameters carried no description and nothing
 * guarded it, while five further completeness dimensions were already
 * clean at 108 of 108 tools and equally unguarded. The audit below turns
 * all of them into ratchets, and the negative tests prove each rule can
 * still fail - a guard that cannot go red guards nothing.
 */
describe("schema completeness", () => {
  test("every advertised parameter documents itself", () => {
    expect(renderCompletenessViolations(auditSchemaCompleteness(TOOLS))).toBe("");
  });

  test("the rule vocabulary is closed and each member is reachable", () => {
    expect(SCHEMA_COMPLETENESS_RULES.toSorted()).toEqual(
      Object.values(SCHEMA_COMPLETENESS_RULE).toSorted(),
    );
    expect(new Set(SCHEMA_COMPLETENESS_RULES).size).toBe(SCHEMA_COMPLETENESS_RULES.length);
  });

  test("a hand-built tool with an undescribed property fails the audit", () => {
    const tool = fakeTool("undocumented_tool", {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    });
    const violations = auditSchemaCompleteness([tool]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe(SCHEMA_COMPLETENESS_RULE.missingDescription);
    expect(violations[0]!.path).toBe(".query");
    expect(renderCompletenessViolations(violations)).toContain("undocumented_tool");
  });

  test("a blank description is a missing one", () => {
    const tool = fakeTool("blank_tool", {
      type: "object",
      properties: { query: { type: "string", description: "   " } },
      additionalProperties: false,
    });
    expect(rulesOf(tool)).toEqual([SCHEMA_COMPLETENESS_RULE.missingDescription]);
  });

  test("array-items nodes are excluded by construction, not by exemption", () => {
    // The array property carries the description; demanding one on
    // `{type:"string"}` items would add 53 noise entries across the live
    // table and teach nobody anything.
    const tool = fakeTool("array_tool", {
      type: "object",
      properties: {
        tags: {
          type: "array",
          description: "Tags to match.",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    });
    expect(auditSchemaCompleteness([tool])).toEqual([]);
  });

  test("a named property nested under array items still has to document itself", () => {
    const tool = fakeTool("nested_tool", {
      type: "object",
      properties: {
        events: {
          type: "array",
          description: "Events to analyse.",
          items: { type: "object", properties: { id: { type: "string" } } },
        },
      },
      additionalProperties: false,
    });
    const violations = auditSchemaCompleteness([tool]);
    expect(violations.map((v) => v.path)).toEqual([".events[].id"]);
  });

  test("a composition keyword is reported rather than silently skipped", () => {
    // There are none today, which is exactly why the silent skip was
    // dangerous: a future composed schema would quietly stop being
    // guarded, with every rule below it passing by never running.
    const tool = fakeTool("composed_tool", {
      type: "object",
      properties: {
        target: {
          description: "Where to write.",
          oneOf: [{ type: "string" }, { type: "integer" }],
        },
      },
      additionalProperties: false,
    });
    const violations = auditSchemaCompleteness([tool]);
    expect(violations.map((v) => v.rule)).toContain(
      SCHEMA_COMPLETENESS_RULE.unsupportedComposition,
    );
    expect(renderCompletenessViolations(violations)).toContain("oneOf");
  });

  test("a tuple-form items array is a composition the walk cannot follow", () => {
    const tool = fakeTool("tuple_tool", {
      type: "object",
      properties: {
        pair: {
          type: "array",
          description: "A fixed pair.",
          items: [{ type: "string" }, { type: "integer" }],
        },
      },
      additionalProperties: false,
    });
    expect(rulesOf(tool)).toContain(SCHEMA_COMPLETENESS_RULE.unsupportedComposition);
  });

  test("an open root is reported - the runtime gate reads that flag", () => {
    const tool = fakeTool("open_tool", {
      type: "object",
      properties: { query: { type: "string", description: "The search text." } },
    });
    expect(rulesOf(tool)).toEqual([SCHEMA_COMPLETENESS_RULE.openRoot]);
  });

  test("a non-object root and a missing properties map are each reported", () => {
    expect(rulesOf(fakeTool("scalar_tool", { type: "string" }))).toEqual([
      SCHEMA_COMPLETENESS_RULE.missingProperties,
      SCHEMA_COMPLETENESS_RULE.nonObjectRoot,
      SCHEMA_COMPLETENESS_RULE.openRoot,
    ]);
  });

  test("a required entry naming no declared property is reported", () => {
    const tool = fakeTool("required_tool", {
      type: "object",
      properties: { query: { type: "string", description: "The search text." } },
      required: ["query", "qeury"],
      additionalProperties: false,
    });
    const violations = auditSchemaCompleteness([tool]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe(SCHEMA_COMPLETENESS_RULE.undeclaredRequired);
    expect(violations[0]!.detail).toContain("qeury");
  });

  test("an untyped node is reported, enum counting as a type", () => {
    const untyped = fakeTool("untyped_tool", {
      type: "object",
      properties: { mode: { description: "How to run." } },
      additionalProperties: false,
    });
    expect(rulesOf(untyped)).toEqual([SCHEMA_COMPLETENESS_RULE.missingType]);
    const enumerated = fakeTool("enum_tool", {
      type: "object",
      properties: { mode: { enum: ["a", "b"], description: "How to run." } },
      additionalProperties: false,
    });
    expect(auditSchemaCompleteness([enumerated])).toEqual([]);
  });

  test("the walk names the kind of every node it visits, root included", () => {
    const nodes = [
      ...schemaNodes("kind_tool", {
        type: "object",
        properties: {
          tags: { type: "array", description: "Tags.", items: { type: "string" } },
          bag: {
            type: "object",
            description: "Free map.",
            additionalProperties: { type: "string" },
          },
        },
        additionalProperties: false,
      }),
    ];
    expect(nodes.map((n) => `${n.path || "<root>"}:${n.kind}`)).toEqual([
      `<root>:${SCHEMA_NODE_KIND.root}`,
      `.tags:${SCHEMA_NODE_KIND.property}`,
      `.tags[]:${SCHEMA_NODE_KIND.items}`,
      `.bag:${SCHEMA_NODE_KIND.property}`,
      `.bag{}:${SCHEMA_NODE_KIND.values}`,
    ]);
  });

  test("both audits read the same traversal", () => {
    // The description-cap audit and the completeness audit disagreeing
    // about which nodes exist is the drift this generalisation removes.
    const tool = fakeTool("shared_walk_tool", {
      type: "object",
      properties: { query: { type: "string", description: "x".repeat(400) } },
      additionalProperties: false,
    });
    expect(auditToolDescriptions([tool]).map((v) => v.path)).toEqual([".query"]);
    expect(auditSchemaCompleteness([tool])).toEqual([]);
  });

  /**
   * Output schemas are deliberately OUT of scope, and this test is the
   * record of that decision rather than an accident of omission.
   *
   * Two reasons. The output-schema vocabulary declares a node with NO
   * type on purpose - `schema_version`, `title`, `next_cursor` are
   * string-or-null and the lightweight response validator has no union -
   * so `missing-type` over an output schema would demand a declaration
   * that is a lie. And no output-schema node carries a description at
   * all (202 of 202 today, `retrieval_trail` among them), so extending
   * the description rule there is a separate 202-entry decision, not a
   * side effect of this one. The output side has its own guard: every
   * response is validated against its schema at request time.
   */
  test("the audit covers input schemas only", () => {
    const withOutput = {
      ...fakeTool("output_tool", {
        type: "object",
        properties: { query: { type: "string", description: "The search text." } },
        additionalProperties: false,
      }),
      outputSchema: {
        type: "object",
        required: ["rows"],
        properties: { rows: { type: "array", items: { type: "object" } }, cursor: {} },
      },
    } as unknown as ToolDefinition;
    expect(auditSchemaCompleteness([withOutput])).toEqual([]);
  });
});
