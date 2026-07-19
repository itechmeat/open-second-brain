/**
 * Skill-proposal verifier gate, versioning, and same-name merge (K1,
 * t_6fc8663c). A draft reaches pending only after the verifier accepts it;
 * accepted skills carry a version that increments on evolution; a same-name
 * collision merges support instead of forking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import {
  procedurePath,
  skillProposalAcceptedPath,
  skillProposalPendingPath,
} from "../../../src/core/brain/paths.ts";
import {
  acceptSkillProposal,
  learnSkillProposals,
  listPendingSkillProposals,
} from "../../../src/core/brain/skill-proposals.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-skill-lifecycle-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Append `count` records of one repeated action, one per minute from `startMin`. */
function seedAction(action: string, count: number, day: string, startMin: number): void {
  for (let i = 0; i < count; i++) {
    const mm = String(startMin + i).padStart(2, "0");
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: `${day}T08:${mm}:00Z`,
      sourceRefs: [{ id: `src-${action}-${day}-${i}` }],
      payload: { action, summary: `did ${action} run ${i}` },
    });
  }
}

function frontmatterOf(path: string): Record<string, unknown> {
  const [fm] = parseFrontmatter(path);
  return fm as Record<string, unknown>;
}

describe("verifier gate before pending", () => {
  test("a well-supported repeated action passes the gate and reaches pending with version 1", () => {
    seedAction("triage_inbox", 3, "2026-05-20", 10);
    const result = learnSkillProposals(vault, {
      now: new Date("2026-06-01T09:00:00Z"),
      minSupport: 3,
    });
    expect(result.created.length).toBeGreaterThanOrEqual(1);

    const pending = listPendingSkillProposals(vault);
    const target = pending.find((p) => p.patternKind === "repeated_action");
    expect(target).toBeDefined();
    const fm = frontmatterOf(skillProposalPendingPath(vault, target!.slug));
    expect(String(fm["version"])).toBe("1");
    expect(typeof fm["name_key"]).toBe("string");
  });
});

describe("same-name merge instead of forking", () => {
  test("a later batch of the same pattern merges into the pending draft", () => {
    seedAction("triage_inbox", 3, "2026-05-20", 10);
    const first = learnSkillProposals(vault, {
      now: new Date("2026-06-01T09:00:00Z"),
      minSupport: 3,
    });
    expect(first.created.length).toBe(listPendingSkillProposals(vault).length);
    const pendingAfterFirst = listPendingSkillProposals(vault).filter(
      (p) => p.patternKind === "repeated_action",
    );
    expect(pendingAfterFirst.length).toBe(1);
    const slug = pendingAfterFirst[0]!.slug;
    const evidenceBefore = Number(
      frontmatterOf(skillProposalPendingPath(vault, slug))["evidence_count"],
    );

    seedAction("triage_inbox", 3, "2026-05-21", 10);
    const second = learnSkillProposals(vault, {
      now: new Date("2026-06-02T09:00:00Z"),
      minSupport: 3,
    });
    // No new fork: still exactly one repeated_action pending draft.
    const pendingAfterSecond = listPendingSkillProposals(vault).filter(
      (p) => p.patternKind === "repeated_action",
    );
    expect(pendingAfterSecond.length).toBe(1);
    expect(second.merged.length).toBeGreaterThanOrEqual(1);
    const evidenceAfter = Number(
      frontmatterOf(skillProposalPendingPath(vault, slug))["evidence_count"],
    );
    expect(evidenceAfter).toBeGreaterThan(evidenceBefore);
  });
});

describe("version increments on evolution", () => {
  test("re-learning a pattern after acceptance evolves the accepted skill and bumps its version", () => {
    seedAction("prepare_release", 3, "2026-05-20", 10);
    learnSkillProposals(vault, { now: new Date("2026-06-01T09:00:00Z"), minSupport: 3 });
    const target = listPendingSkillProposals(vault).find(
      (p) => p.patternKind === "repeated_action",
    );
    expect(target).toBeDefined();
    const accepted = acceptSkillProposal(vault, target!.slug, {
      now: new Date("2026-06-01T10:00:00Z"),
    });
    expect(Number(frontmatterOf(accepted.proposalPath)["version"])).toBe(1);
    expect(Number(frontmatterOf(procedurePath(vault, target!.slug))["version"])).toBe(1);

    seedAction("prepare_release", 3, "2026-05-21", 10);
    const evolve = learnSkillProposals(vault, {
      now: new Date("2026-06-02T09:00:00Z"),
      minSupport: 3,
    });
    expect(evolve.merged.length).toBeGreaterThanOrEqual(1);
    // No new pending fork was created for the accepted name.
    expect(listPendingSkillProposals(vault).some((p) => p.patternKind === "repeated_action")).toBe(
      false,
    );
    // The accepted skill and its procedure evolved to version 2.
    expect(Number(frontmatterOf(skillProposalAcceptedPath(vault, target!.slug))["version"])).toBe(
      2,
    );
    expect(Number(frontmatterOf(procedurePath(vault, target!.slug))["version"])).toBe(2);
  });
});
