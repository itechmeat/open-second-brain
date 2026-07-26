/**
 * Skill contract completeness (no-dead-ends, Unit I / Task 20).
 *
 * Three things this pins:
 *   1. acceptance WRITES prerequisites / rollback / side effects /
 *      verification and the procedural-memory reader READS them back, so
 *      they are a contract rather than frontmatter decoration;
 *   2. a proposal's self-reported evidence is resolved against the
 *      independently recorded procedural outcome ledger, keeping the three
 *      outcome states distinct (failures, successes, nothing recorded);
 *   3. the accept sequence is a compensating transaction - a crash at each
 *      of its three gaps leaves neither a duplicate nor an orphan.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import {
  procedurePath,
  proceduralMemoryIndexPath,
  skillProposalAcceptedPath,
  skillProposalPendingPath,
} from "../../../src/core/brain/paths.ts";
import {
  acceptSkillProposal,
  learnSkillProposals,
  listPendingSkillProposals,
  recoverSkillProposalAccepts,
  resolveSkillProposalEvidence,
} from "../../../src/core/brain/skill-proposals.ts";
import {
  listSkillAcceptJournals,
  writeSkillAcceptJournal,
} from "../../../src/core/brain/skill-accept-journal.ts";
import {
  listProceduralMemory,
  proceduralEntryId,
  recordProceduralOutcome,
} from "../../../src/core/brain/procedural-memory.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-skill-contract-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const ACCEPTED_AT = new Date("2026-06-01T10:00:00.000Z");
const LEARNED_AT = new Date("2026-06-01T09:00:00.000Z");

/** Seed three records of one repeated action; returns the drafted slug. */
function seedAndLearn(action: string): string {
  for (let i = 0; i < 3; i++) {
    const mm = String(10 + i).padStart(2, "0");
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: `2026-05-20T08:${mm}:00Z`,
      sourceRefs: [{ id: `src-${action.replaceAll("_", "-")}-${i}` }],
      payload: { action, summary: `did ${action} run ${i}` },
    });
  }
  learnSkillProposals(vault, { now: LEARNED_AT, minSupport: 3 });
  const target = listPendingSkillProposals(vault).find((p) => p.patternKind === "repeated_action");
  if (!target) throw new Error("test setup: no repeated_action draft was created");
  return target.slug;
}

function frontmatterOf(path: string): Record<string, unknown> {
  const [fm] = parseFrontmatter(path);
  return fm as Record<string, unknown>;
}

const CONTRACT = {
  prerequisites: ["o2b brain doctor --json reports zero blocking issues"],
  rollback: ["o2b brain restore --snapshot pre-rotate"],
  sideEffects: ["rewrites Brain/procedural-memory/index.json"],
  verification: ["o2b brain procedures list --json"],
} as const;

describe("the skill contract is written on acceptance", () => {
  test("acceptance writes the four contract fields and the reader returns them", () => {
    const slug = seedAndLearn("rotate_keys");
    const accepted = acceptSkillProposal(vault, slug, { now: ACCEPTED_AT, contract: CONTRACT });

    const archiveFm = frontmatterOf(accepted.proposalPath);
    expect(archiveFm["prerequisites"]).toEqual([...CONTRACT.prerequisites]);
    expect(archiveFm["rollback"]).toEqual([...CONTRACT.rollback]);
    expect(archiveFm["side_effects"]).toEqual([...CONTRACT.sideEffects]);
    expect(archiveFm["verification"]).toEqual([...CONTRACT.verification]);

    const procFm = frontmatterOf(procedurePath(vault, slug));
    expect(procFm["prerequisites"]).toEqual([...CONTRACT.prerequisites]);
    expect(procFm["rollback"]).toEqual([...CONTRACT.rollback]);
    expect(procFm["side_effects"]).toEqual([...CONTRACT.sideEffects]);
    expect(procFm["verification"]).toEqual([...CONTRACT.verification]);

    // The contract is read BACK by the procedural-memory reader, so it
    // reaches a consumer instead of decorating a file nobody parses.
    const entry = listProceduralMemory(vault).find(
      (e) => e.sourcePath === `Brain/procedures/proc-${slug}.md`,
    );
    expect(entry).toBeDefined();
    expect(entry!.prerequisites).toEqual([...CONTRACT.prerequisites]);
    expect(entry!.rollback).toEqual([...CONTRACT.rollback]);
    expect(entry!.sideEffects).toEqual([...CONTRACT.sideEffects]);
    expect(entry!.verification).toEqual([...CONTRACT.verification]);
  });

  test("an empty contract entry is refused by name instead of silently dropped", () => {
    const slug = seedAndLearn("rotate_keys");
    expect(() =>
      acceptSkillProposal(vault, slug, {
        now: ACCEPTED_AT,
        contract: { prerequisites: ["   "] },
      }),
    ).toThrow(/skill contract field 'prerequisites'/);
    // Nothing was written: the draft is still pending and unreviewed.
    expect(existsSync(skillProposalPendingPath(vault, slug))).toBe(true);
    expect(existsSync(skillProposalAcceptedPath(vault, slug))).toBe(false);
    expect(existsSync(procedurePath(vault, slug))).toBe(false);
  });
});

describe("byte-identical when the contract is absent", () => {
  test("accepting with no contract produces exactly the pre-contract bytes", () => {
    const slug = seedAndLearn("rotate_keys");
    expect(slug).toBe("repeated_action-rotate-keys-0e4b812f");
    acceptSkillProposal(vault, slug, { now: ACCEPTED_AT });

    // Golden bytes captured from the accept path BEFORE this unit landed.
    expect(readFileSync(skillProposalAcceptedPath(vault, slug), "utf8")).toBe(
      '---\nschema_version: 1\nkind: brain-skill-proposal\nid: prop-repeated_action-rotate-keys-0e4b812f\nslug: repeated_action-rotate-keys-0e4b812f\nstatus: accepted\npattern_kind: repeated_action\nname_key: "repeated_action:rotate_keys"\nversion: 1\nconfidence: 0.550\npayload_hash: 0e4b812f12089af795a186a2ac11330f26cdefb4f8e4d216d8ac6b3465bc64e0\ncreated_at: "2026-06-01T09:00:00.000Z"\nupdated_at: "2026-06-01T10:00:00.000Z"\nwatermark_from: ""\nwatermark_to: "2026-05-20T08:12:00Z"\nevidence_count: 3\nsource_refs: [ctn_20260520081000_d9c5e970465448f3, src-rotate-keys-0, ctn_20260520081100_5917efe2f4a20f97, src-rotate-keys-1, ctn_20260520081200_3d2812bae9bdffbe, src-rotate-keys-2]\nreviewed_at: "2026-06-01T10:00:00.000Z"\n---\n\n# Repeated action: rotate_keys\n\n## Pattern\n- kind: repeated_action\n- key: rotate_keys\n\n## Suggested skill body\nWhen pattern `rotate_keys` appears, follow the observed repeatable workflow.\nCapture inputs first, execute steps in stable order, and emit audit-friendly outputs.\n\n## Evidence\n- 2026-05-20T08:10:00Z :: session_turn :: ctn_20260520081000_d9c5e970465448f3 :: did rotate_keys run 0\n- 2026-05-20T08:11:00Z :: session_turn :: ctn_20260520081100_5917efe2f4a20f97 :: did rotate_keys run 1\n- 2026-05-20T08:12:00Z :: session_turn :: ctn_20260520081200_3d2812bae9bdffbe :: did rotate_keys run 2\n',
    );
    expect(readFileSync(procedurePath(vault, slug), "utf8")).toBe(
      '---\nschema_version: 1\nkind: brain-procedure\nid: proc-repeated_action-rotate-keys-0e4b812f\nslug: repeated_action-rotate-keys-0e4b812f\nsource_proposal: prop-repeated_action-rotate-keys-0e4b812f\nversion: 1\ncreated_at: "2026-06-01T10:00:00.000Z"\nupdated_at: "2026-06-01T10:00:00.000Z"\nstatus: active\n---\n\n# Procedure\n\nAccepted from proposal: [[prop-repeated_action-rotate-keys-0e4b812f]]\n\nWhen pattern `rotate_keys` appears, follow the observed repeatable workflow.\nCapture inputs first, execute steps in stable order, and emit audit-friendly outputs.\n\n## Evidence\n- 2026-05-20T08:10:00Z :: session_turn :: ctn_20260520081000_d9c5e970465448f3 :: did rotate_keys run 0\n- 2026-05-20T08:11:00Z :: session_turn :: ctn_20260520081100_5917efe2f4a20f97 :: did rotate_keys run 1\n- 2026-05-20T08:12:00Z :: session_turn :: ctn_20260520081200_3d2812bae9bdffbe :: did rotate_keys run 2\n',
    );
    // The journal is a transient repair marker, not a residue.
    expect(listSkillAcceptJournals(vault)).toHaveLength(0);
  });
});

describe("claimed evidence resolved against the recorded outcome ledger", () => {
  test("no recorded outcome, recorded successes and recorded failures stay three distinct states", () => {
    const slug = seedAndLearn("rotate_keys");
    acceptSkillProposal(vault, slug, { now: ACCEPTED_AT });
    const entryId = proceduralEntryId(`Brain/procedures/proc-${slug}.md`);

    // State 1 - nothing recorded. NOT "no failures": the rate is null.
    const fresh = resolveSkillProposalEvidence(vault, slug);
    expect(fresh.claimedEvidenceCount).toBe(3);
    expect(fresh.proceduralEntryId).toBe(entryId);
    expect(fresh.proceduralEntryPresent).toBe(true);
    expect(fresh.recordedSuccesses).toBe(0);
    expect(fresh.recordedFailures).toBe(0);
    expect(fresh.recordedSuccessRate).toBeNull();
    expect(fresh.outcomeState).toBe("unrecorded");

    // State 2 - recorded failures.
    expect(recordProceduralOutcome(vault, entryId, "failure")).not.toBeNull();
    const failing = resolveSkillProposalEvidence(vault, slug);
    expect(failing.recordedFailures).toBe(1);
    expect(failing.recordedSuccessRate).toBe(0);
    expect(failing.outcomeState).toBe("failing");

    // State 3 - recorded successes alongside them is a fourth, honest state.
    expect(recordProceduralOutcome(vault, entryId, "success")).not.toBeNull();
    const mixed = resolveSkillProposalEvidence(vault, slug);
    expect(mixed.recordedSuccesses).toBe(1);
    expect(mixed.recordedFailures).toBe(1);
    expect(mixed.outcomeState).toBe("mixed");

    // Success-only is distinguishable from all of the above.
    const other = seedAndLearnSecond();
    acceptSkillProposal(vault, other, { now: ACCEPTED_AT });
    const otherId = proceduralEntryId(`Brain/procedures/proc-${other}.md`);
    expect(recordProceduralOutcome(vault, otherId, "success")).not.toBeNull();
    const successful = resolveSkillProposalEvidence(vault, other);
    expect(successful.recordedSuccessRate).toBe(1);
    expect(successful.outcomeState).toBe("successful");
  });

  test("a pending proposal has no ledger entry, which is not the same as zero outcomes", () => {
    const slug = seedAndLearn("rotate_keys");
    const pending = resolveSkillProposalEvidence(vault, slug);
    expect(pending.phase).toBe("pending");
    expect(pending.proceduralEntryPresent).toBe(false);
    expect(pending.recordedSuccesses).toBeNull();
    expect(pending.recordedFailures).toBeNull();
    expect(pending.recordedSuccessRate).toBeNull();
    expect(pending.outcomeState).toBe("unrecorded");
  });

  test("an unknown slug raises a named error rather than an empty resolution", () => {
    expect(() => resolveSkillProposalEvidence(vault, "no-such-slug")).toThrow(
      /skill proposal not found in any phase: no-such-slug/,
    );
  });
});

/** Seed a second distinct pattern in the same vault; returns its slug. */
function seedAndLearnSecond(): string {
  const before = new Set(listPendingSkillProposals(vault).map((p) => p.slug));
  for (let i = 0; i < 3; i++) {
    const mm = String(20 + i).padStart(2, "0");
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: `2026-05-21T08:${mm}:00Z`,
      sourceRefs: [{ id: `src-publish-${i}` }],
      payload: { action: "publish_release", summary: `did publish_release run ${i}` },
    });
  }
  learnSkillProposals(vault, { now: new Date("2026-06-02T09:00:00Z"), minSupport: 3 });
  const target = listPendingSkillProposals(vault).find(
    (p) => p.patternKind === "repeated_action" && !before.has(p.slug),
  );
  if (!target) throw new Error("test setup: no second repeated_action draft was created");
  return target.slug;
}

describe("the accept sequence survives a crash at each of its three gaps", () => {
  /**
   * Reproduce the on-disk state a crash would leave at `phase` by running a
   * real accept and then undoing the steps that would not yet have happened.
   */
  function crashAfter(slug: string, phase: "archive" | "materialize" | "commit"): void {
    const pendingPath = skillProposalPendingPath(vault, slug);
    const pendingBytes = readFileSync(pendingPath, "utf8");
    acceptSkillProposal(vault, slug, { now: ACCEPTED_AT });
    if (phase === "archive") {
      rmSync(procedurePath(vault, slug));
      writeFileSync(pendingPath, pendingBytes, "utf8");
    } else if (phase === "materialize") {
      writeFileSync(pendingPath, pendingBytes, "utf8");
    } else {
      rmSync(join(vault, "Brain", "procedural-memory"), { recursive: true, force: true });
    }
    writeSkillAcceptJournal(vault, {
      slug,
      id: `prop-${slug}`,
      phase,
      startedAt: ACCEPTED_AT.toISOString(),
      acceptedExisted: false,
      procedureExisted: false,
    });
  }

  test("gap 1 - crash before the procedure was written leaves no orphaned archive", () => {
    const slug = seedAndLearn("rotate_keys");
    crashAfter(slug, "archive");

    const recovered = recoverSkillProposalAccepts(vault);
    expect(recovered.map((r) => r.action)).toEqual(["rolled_back"]);
    expect(existsSync(skillProposalAcceptedPath(vault, slug))).toBe(false);
    expect(existsSync(procedurePath(vault, slug))).toBe(false);
    expect(existsSync(skillProposalPendingPath(vault, slug))).toBe(true);
    expect(listSkillAcceptJournals(vault)).toHaveLength(0);
  });

  test("gap 2 - crash before the pending copy was removed leaves no duplicate", () => {
    const slug = seedAndLearn("rotate_keys");
    crashAfter(slug, "materialize");
    // The duplicate is real before recovery: pending AND accepted both exist.
    expect(existsSync(skillProposalPendingPath(vault, slug))).toBe(true);
    expect(existsSync(skillProposalAcceptedPath(vault, slug))).toBe(true);

    const recovered = recoverSkillProposalAccepts(vault);
    expect(recovered.map((r) => r.action)).toEqual(["rolled_back"]);
    expect(existsSync(skillProposalAcceptedPath(vault, slug))).toBe(false);
    expect(existsSync(procedurePath(vault, slug))).toBe(false);
    expect(existsSync(skillProposalPendingPath(vault, slug))).toBe(true);
  });

  test("gap 3 - crash before the projections were rebuilt repairs them instead of leaving them stale", () => {
    const slug = seedAndLearn("rotate_keys");
    crashAfter(slug, "commit");
    expect(existsSync(proceduralMemoryIndexPath(vault))).toBe(false);

    const recovered = recoverSkillProposalAccepts(vault);
    expect(recovered.map((r) => r.action)).toEqual(["completed"]);
    // Rolled FORWARD: the pending copy is gone, so the accept had committed.
    expect(existsSync(skillProposalPendingPath(vault, slug))).toBe(false);
    expect(existsSync(skillProposalAcceptedPath(vault, slug))).toBe(true);
    expect(existsSync(procedurePath(vault, slug))).toBe(true);
    expect(
      listProceduralMemory(vault).some((e) => e.sourcePath === `Brain/procedures/proc-${slug}.md`),
    ).toBe(true);
    expect(listSkillAcceptJournals(vault)).toHaveLength(0);
  });

  test("an exception materializing the procedure rolls the archive back and clears the journal", () => {
    const slug = seedAndLearn("rotate_keys");
    // A procedure already at the target path makes the exclusive write throw.
    mkdirSync(dirname(procedurePath(vault, slug)), { recursive: true });
    writeFileSync(procedurePath(vault, slug), "---\nkind: brain-procedure\n---\n\n# Squatter\n", {
      encoding: "utf8",
    });

    expect(() => acceptSkillProposal(vault, slug, { now: ACCEPTED_AT })).toThrow(
      /procedure already exists/,
    );
    expect(existsSync(skillProposalAcceptedPath(vault, slug))).toBe(false);
    expect(existsSync(skillProposalPendingPath(vault, slug))).toBe(true);
    // The pre-existing file was NOT deleted by the rollback.
    expect(readFileSync(procedurePath(vault, slug), "utf8")).toContain("# Squatter");
    expect(listSkillAcceptJournals(vault)).toHaveLength(0);
  });

  test("a stale journal is swept by the next accept, not left for a human", () => {
    const slug = seedAndLearn("rotate_keys");
    crashAfter(slug, "materialize");
    const second = seedAndLearnSecond();

    acceptSkillProposal(vault, second, { now: ACCEPTED_AT });
    // Accepting an unrelated draft resolved the abandoned sequence.
    expect(existsSync(skillProposalAcceptedPath(vault, slug))).toBe(false);
    expect(existsSync(skillProposalPendingPath(vault, slug))).toBe(true);
    expect(existsSync(skillProposalAcceptedPath(vault, second))).toBe(true);
  });
});
