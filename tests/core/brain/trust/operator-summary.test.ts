import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DreamRunSummary } from "../../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  buildOperatorSummary,
  renderOperatorSummaryMarkdown,
} from "../../../../src/core/brain/trust/operator-summary.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-op-summary-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function emptyDream(over: Partial<DreamRunSummary> = {}): DreamRunSummary {
  return Object.freeze({
    run_id: "dream-2026-05-25-000000",
    changed: false,
    new_unconfirmed: [],
    confirmed: [],
    retired: [],
    contradictions: [],
    moved_to_processed: [],
    suppressed: [],
    warnings: [],
    uncertain: [],
    quarantined: [],
    ...over,
  }) as DreamRunSummary;
}

describe("buildOperatorSummary - structural envelope", () => {
  test("clean vault produces all-zero envelope with trust=clean", () => {
    const r = buildOperatorSummary(vault, { dreamSummary: emptyDream() });
    expect(r.trust_verdict).toBe("clean");
    expect(r.verification_delta.summary.confirmed).toBe(0);
    expect(r.verification_delta.summary.drift).toBe(0);
    expect(r.instruction_file_warnings).toEqual([]);
    expect(r.doctor_summary.warning_count).toBe(0);
    expect(r.doctor_summary.error_count).toBe(0);
    expect(r.dream_summary.warning_count).toBe(0);
    expect(r.dream_summary.uncertain_count).toBe(0);
    expect(r.dream_summary.quarantined_count).toBe(0);
  });

  test("instruction-file warning surfaces in envelope; verdict stays clean (informational)", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "line\n".repeat(300));
    const r = buildOperatorSummary(vault, {
      dreamSummary: emptyDream(),
      guardrails: {
        promotion_min_signals: 2,
        promotion_min_distinct_agents: 1,
        promotion_min_age_days: 0,
        instruction_file_max_lines: 100,
        untrusted_source_delimiting: false,
        derived_fact_synthesis: false,
        provenance_trust_ordering: false,
        owner_scoped_facts: false,
      },
    });
    expect(r.instruction_file_warnings).toHaveLength(1);
    expect(r.instruction_file_warnings[0]?.path).toBe("CLAUDE.md");
    // Doctor errors zero; instruction-file warning is informational only
    // and is NOT counted toward the trust verdict (it lives outside the
    // doctor warnings list). Verdict stays clean.
    expect(r.trust_verdict).toBe("clean");
  });

  test("without dream summary, verification delta is empty and trust is clean", () => {
    const r = buildOperatorSummary(vault, {});
    expect(r.verification_delta.summary.confirmed).toBe(0);
    expect(r.verification_delta.entries).toEqual([]);
    expect(r.trust_verdict).toBe("clean");
  });

  test("returned object is frozen", () => {
    const r = buildOperatorSummary(vault, { dreamSummary: emptyDream() });
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe("renderOperatorSummaryMarkdown", () => {
  test("markdown contains the three signal sections", () => {
    const r = buildOperatorSummary(vault, { dreamSummary: emptyDream() });
    const md = renderOperatorSummaryMarkdown(r);
    expect(md).toContain("# Operator summary");
    expect(md).toContain("Trust:");
    expect(md).toContain("Doctor:");
    expect(md).toContain("Dream:");
  });

  test("markdown lists instruction-file warnings when present", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "x\n".repeat(300));
    const r = buildOperatorSummary(vault, {
      dreamSummary: emptyDream(),
      guardrails: {
        promotion_min_signals: 2,
        promotion_min_distinct_agents: 1,
        promotion_min_age_days: 0,
        instruction_file_max_lines: 100,
        untrusted_source_delimiting: false,
        derived_fact_synthesis: false,
        provenance_trust_ordering: false,
        owner_scoped_facts: false,
      },
    });
    const md = renderOperatorSummaryMarkdown(r);
    expect(md).toContain("CLAUDE.md");
  });
});
