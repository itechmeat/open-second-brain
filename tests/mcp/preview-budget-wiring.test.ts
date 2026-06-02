import { describe, expect, test } from "bun:test";

import { buildToolTable } from "../../src/mcp/tools.ts";
import { MCP_PREVIEW_BUDGET } from "../../src/mcp/preview-budget.ts";

/**
 * The exact set of tools that opt into the preview budget. Kept explicit
 * so adding/removing a budget is a deliberate, reviewed change rather
 * than an accident of a default.
 */
const BUDGETED = new Set<string>([
  "brain_brief",
  "brain_analytics",
  "brain_search",
  "brain_context_pack",
  "brain_digest",
  "brain_timeline",
  "brain_concept_synthesis",
  "brain_operator_summary",
  "brain_weekly_synthesis",
  "brain_monthly_review",
  "brain_daily_brief",
  "second_brain_status",
  "second_brain_query",
]);

describe("preview-budget wiring", () => {
  test("exactly the enumerated large tools carry the shared budget", () => {
    const table = buildToolTable("full");
    const withBudget = new Set<string>();
    for (const tool of table) {
      if (tool.previewBudget !== undefined) {
        withBudget.add(tool.name);
        expect(tool.previewBudget).toBe(MCP_PREVIEW_BUDGET);
      }
    }
    expect([...withBudget].toSorted()).toEqual([...BUDGETED].toSorted());
  });

  test("small status/echo and writer tools stay unbudgeted", () => {
    const table = buildToolTable("full");
    const byName = new Map(table.map((t) => [t.name, t]));
    for (const name of [
      "brain_feedback",
      "brain_note",
      "brain_apply_evidence",
      "brain_artifact_get",
      "vault_health",
      "brain_doctor",
    ]) {
      expect(byName.get(name)?.previewBudget).toBeUndefined();
    }
  });
});
