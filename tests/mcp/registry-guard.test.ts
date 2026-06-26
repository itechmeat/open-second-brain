/**
 * Registry guard (token-diet, t_352fd7f6 + t_c967abaf): the serialized
 * tool registry is paid by every MCP client on every request in
 * non-deferred hosts, so description growth and unbounded outputs are
 * contract violations, not style issues.
 */

import { describe, expect, test } from "bun:test";

import {
  auditPreviewBudgets,
  auditToolDescriptions,
  PREVIEW_BUDGET_EXEMPT,
} from "../../src/mcp/registry-guard.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

const TOOLS = buildToolTable("full");

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
      expect(reason.trim().length, name).toBeGreaterThan(10);
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
