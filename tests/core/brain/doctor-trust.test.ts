/**
 * v0.10.16: doctor pass wires the trust helpers - instruction-file
 * ceiling, verification delta (when a dream summary is supplied), and
 * trust verdict. Tests cover the clean path, the ceiling-breach path,
 * and verification-delta integration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import type { DreamRunSummary } from "../../../src/core/brain/dream.ts";
import { brainConfigPath, brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;

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

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-trust-"));
  const dirs = brainDirs(vault);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(brainConfigPath(vault), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("runDoctor - trust integration", () => {
  test("clean vault: trust_verdict = clean", () => {
    const result = runDoctor(vault);
    expect(result.trust_verdict).toBe("clean");
    expect(result.instruction_file_warnings ?? []).toEqual([]);
  });

  test("long CLAUDE.md surfaces instruction-file warning", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "x\n".repeat(300));
    const result = runDoctor(vault);
    expect(result.instruction_file_warnings ?? []).toHaveLength(1);
    expect(result.instruction_file_warnings![0]?.path).toBe("CLAUDE.md");
    expect(result.instruction_file_warnings![0]?.lines).toBe(300);
  });

  test("dream summary citing missing pref triggers investigate verdict", () => {
    const result = runDoctor(vault, {
      dreamSummary: emptyDream({ confirmed: ["pref-ghost"] }),
    });
    expect(result.verification_delta_summary?.missing_evidence).toBe(1);
    expect(result.trust_verdict).toBe("investigate");
  });

  test("ceiling can be overridden via guardrails option", () => {
    writeFileSync(join(vault, "AGENTS.md"), "y\n".repeat(50));
    const result = runDoctor(vault, {
      guardrails: {
        promotion_min_signals: 2,
        promotion_min_distinct_agents: 1,
        promotion_min_age_days: 0,
        instruction_file_max_lines: 30,
        untrusted_source_delimiting: false,
        derived_fact_synthesis: false,
        provenance_trust_ordering: false,
        owner_scoped_facts: false,
        marker_writeback: false,
      },
    });
    expect(result.instruction_file_warnings ?? []).toHaveLength(1);
  });
});
