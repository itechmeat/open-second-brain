/**
 * Skill proposals, the accept journal and procedural memory on the lane
 * page store (task 2.10 WP6), in every mode: an unswitched machine writes
 * its pages, a store-only machine and one with no vault write lane-entry
 * records and leave the vault unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import {
  acceptSkillProposal,
  learnSkillProposals,
  listPendingSkillProposals,
  recoverSkillProposalAccepts,
  rejectSkillProposal,
  SkillAcceptLockedError,
  skillAcceptLockPath,
} from "../../../src/core/brain/skill-proposals.ts";
import {
  readSkillAcceptJournals,
  writeSkillAcceptJournal,
} from "../../../src/core/brain/skill-accept-journal.ts";
import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import {
  listProceduralMemory,
  reconcileProceduralMemory,
} from "../../../src/core/brain/procedural-memory.ts";
import { readProceduralGraph } from "../../../src/core/brain/procedural-graph.ts";
import { procedurePath } from "../../../src/core/brain/paths.ts";
import { laneVaultRoot, lanePageExists } from "../../../src/core/store/lane-pages.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

describe.each(LANE_MODES)("skill and procedure lanes (%s)", (mode) => {
  test("learn, accept, reject, reconcile and project", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    seedCorePatterns(vault);
    // The continuity rows are another package's ledger; the lanes are measured from here.
    const before = lane.vaultHash();
    learnSkillProposals(vault, { now: new Date("2026-06-01T12:00:00Z"), minSupport: 3 });
    const pending = listPendingSkillProposals(vault);
    const accept = pending.find((p) => p.patternKind === "repeated_action")!;
    const reject = pending.find((p) => p.patternKind === "co_occurrence")!;
    expect(accept).toBeDefined();
    expect(reject).toBeDefined();
    expect(
      acceptSkillProposal(vault, accept.slug, { now: new Date("2026-06-01T12:10:00Z") }).status,
    ).toBe("accepted");
    expect(lanePageExists(vault, procedurePath(vault, accept.slug))).toBe(true);
    rejectSkillProposal(vault, reject.slug, {
      now: new Date("2026-06-01T12:20:00Z"),
      note: "noisy",
    });
    expect(listPendingSkillProposals(vault).map((p) => p.slug)).not.toContain(accept.slug);
    reconcileProceduralMemory(vault, { roots: [join(vault, "Brain", "procedures")] });
    expect(listProceduralMemory(vault).length).toBeGreaterThan(0);
    expect(readProceduralGraph(vault)).not.toBeNull();
    if (mode === "legacy") return;
    expect(lane.vaultHash()).toBe(before);
    expect(existsSync(laneVaultRoot(null))).toBe(false);
    const lanes = new Set(lane.laneRecords().map((r) => String(r.body["lane"])));
    expect(lanes.has("skill-proposals")).toBe(true);
    expect(lanes.has("procedures")).toBe(true);
  });
});

describe.each(LANE_MODES)("the skill accept journal (%s)", (mode) => {
  test("a journal left by an interrupted accept is read back and resolved", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    const before = lane.vaultHash();
    writeSkillAcceptJournal(vault, {
      slug: "half-done",
      id: "sp-half-done",
      phase: "archive",
      startedAt: "2026-06-01T12:00:00Z",
      acceptedExisted: false,
      materializedExisted: false,
    });
    expect(readSkillAcceptJournals(vault).entries.map((e) => e.slug)).toEqual(["half-done"]);
    expect(recoverSkillProposalAccepts(vault).map((r) => r.slug)).toEqual(["half-done"]);
    expect(readSkillAcceptJournals(vault).entries).toEqual([]);
    if (mode === "legacy") return;
    expect(lane.vaultHash()).toBe(before);
    // A repair marker is machine state, never a lane record.
    expect(lane.laneRecords()).toEqual([]);
  });

  test("a held accept lock refuses and names a file that is there", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    const held = acquireLockSync(skillAcceptLockPath(vault).replace(/\.lock$/u, ""));
    try {
      let refusal: unknown = null;
      try {
        recoverSkillProposalAccepts(vault);
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(SkillAcceptLockedError);
      expect(existsSync((refusal as SkillAcceptLockedError).path)).toBe(true);
    } finally {
      held.release();
    }
  });
});

function seedCorePatterns(vaultPath: string): void {
  const records = [
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-20T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 101 in module alpha",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-20T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 102 in module beta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-21T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 103 in module gamma",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-21T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 104 in module delta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-22T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 105 in module epsilon",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-22T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 106 in module zeta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-23T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 107 in module eta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-23T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 108 in module theta",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-24T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 109 in module iota",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-24T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 110 in module kappa",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-25T08:10:00Z",
      payload: {
        action: "triage_inbox",
        summary: "Investigate issue 111 in module lambda",
      },
    },
    {
      kind: "session_turn" as const,
      createdAt: "2026-05-25T08:12:00Z",
      payload: {
        action: "prepare_release_notes",
        summary: "Investigate issue 112 in module mu",
      },
    },
  ];

  for (const record of records) {
    appendContinuityRecord(vaultPath, {
      kind: record.kind,
      createdAt: record.createdAt,
      sourceRefs: [{ id: `src-${record.createdAt}` }],
      payload: record.payload,
    });
  }
}
