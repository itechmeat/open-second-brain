import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import {
  procedurePath,
  proposalWatermarkPath,
  skillProposalAcceptedPath,
  skillProposalRejectedPath,
} from "../../../src/core/brain/paths.ts";
import {
  acceptSkillProposal,
  learnSkillProposals,
  listPendingSkillProposals,
  rejectSkillProposal,
} from "../../../src/core/brain/skill-proposals.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-skill-proposals-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("skill proposal learning", () => {
  test("detects repeated action, structural similarity, co-occurrence, and temporal routine", () => {
    seedCorePatterns(vault);

    const result = learnSkillProposals(vault, {
      now: new Date("2026-06-01T09:00:00Z"),
      minSupport: 3,
    });

    expect(result.scanned).toBeGreaterThanOrEqual(12);
    expect(result.created.length).toBeGreaterThanOrEqual(4);
    const pending = listPendingSkillProposals(vault);
    const kinds = pending.map((item) => item.patternKind).toSorted();
    expect(kinds).toContain("repeated_action");
    expect(kinds).toContain("structural_similarity");
    expect(kinds).toContain("co_occurrence");
    expect(kinds).toContain("temporal_routine");
  });

  test("a candidate clearing detection above the evidence-sample cap still passes the verifier", () => {
    // Seven records share one action, so the repeated_action candidate has
    // support 7 - above the 6-record evidence sample the candidate carries.
    // With minSupport 7 the verifier must see the full support count (not the
    // truncated sample) and accept, not reject.
    for (let i = 0; i < 7; i++) {
      appendContinuityRecord(vault, {
        kind: "session_turn",
        createdAt: `2026-05-2${i}T08:00:00Z`,
        sourceRefs: [{ id: `src-${i}` }],
        payload: { action: "deploy_service", summary: `run ${i}` },
      });
    }

    const result = learnSkillProposals(vault, {
      now: new Date("2026-06-01T09:00:00Z"),
      minSupport: 7,
    });

    expect(result.verifierRejected).toHaveLength(0);
    const pending = listPendingSkillProposals(vault);
    expect(pending.some((item) => item.patternKind === "repeated_action")).toBe(true);
  });

  test("advances watermark and suppresses unchanged reruns", () => {
    seedCorePatterns(vault);

    const first = learnSkillProposals(vault, {
      now: new Date("2026-06-01T10:00:00Z"),
      minSupport: 3,
    });
    expect(first.created.length).toBeGreaterThanOrEqual(1);
    expect(first.watermarkTo).not.toBeNull();

    const wmPath = proposalWatermarkPath(vault);
    const wm = JSON.parse(readFileSync(wmPath, "utf8")) as {
      lastCreatedAt: string | null;
      lastId: string | null;
    };
    expect(wm.lastCreatedAt).toBe(first.watermarkTo);
    expect(typeof wm.lastId).toBe("string");

    const second = learnSkillProposals(vault, {
      now: new Date("2026-06-01T11:00:00Z"),
      minSupport: 3,
    });
    expect(second.scanned).toBe(0);
    expect(second.created).toHaveLength(0);
    expect(listPendingSkillProposals(vault).length).toBe(first.created.length);
  });

  test("replays same-timestamp records using watermark id cursor", () => {
    seedCorePatterns(vault);

    const first = learnSkillProposals(vault, {
      now: new Date("2026-06-01T10:00:00Z"),
      minSupport: 3,
    });
    expect(first.watermarkTo).not.toBeNull();

    const wmPath = proposalWatermarkPath(vault);
    const wm = JSON.parse(readFileSync(wmPath, "utf8")) as {
      lastCreatedAt: string | null;
      lastId: string | null;
    };
    expect(wm.lastCreatedAt).not.toBeNull();
    expect(wm.lastId).not.toBeNull();

    let appendedHigherId = false;
    for (let i = 0; i < 256; i++) {
      const rec = appendContinuityRecord(vault, {
        kind: "session_turn",
        createdAt: wm.lastCreatedAt!,
        sourceRefs: [{ id: `late-src-${i}` }],
        payload: {
          action: `late_action_${i}`,
          summary: `late summary ${i}`,
        },
      });
      if (rec.id > wm.lastId!) {
        appendedHigherId = true;
        break;
      }
    }
    expect(appendedHigherId).toBe(true);

    const second = learnSkillProposals(vault, {
      now: new Date("2026-06-01T11:00:00Z"),
      minSupport: 3,
    });
    expect(second.scanned).toBeGreaterThan(0);
  });

  test("accept moves proposal and creates procedure artifact", () => {
    seedCorePatterns(vault);
    learnSkillProposals(vault, {
      now: new Date("2026-06-01T12:00:00Z"),
      minSupport: 3,
    });

    const pending = listPendingSkillProposals(vault);
    const target = pending.find((item) => item.patternKind === "repeated_action");
    expect(target).toBeDefined();

    const accepted = acceptSkillProposal(vault, target!.slug, {
      now: new Date("2026-06-01T12:10:00Z"),
      note: "looks stable",
    });

    expect(accepted.status).toBe("accepted");
    expect(existsSync(skillProposalAcceptedPath(vault, target!.slug))).toBe(true);
    expect(existsSync(procedurePath(vault, target!.slug))).toBe(true);
    expect(listPendingSkillProposals(vault).some((item) => item.slug === target!.slug)).toBe(false);
  });

  test("reject moves proposal and prevents unchanged reappearance", () => {
    seedCorePatterns(vault);
    learnSkillProposals(vault, {
      now: new Date("2026-06-01T13:00:00Z"),
      minSupport: 3,
    });

    const pending = listPendingSkillProposals(vault);
    const target = pending.find((item) => item.patternKind === "co_occurrence");
    expect(target).toBeDefined();

    const rejected = rejectSkillProposal(vault, target!.slug, {
      now: new Date("2026-06-01T13:10:00Z"),
      note: "too noisy",
    });

    expect(rejected.status).toBe("rejected");
    expect(existsSync(skillProposalRejectedPath(vault, target!.slug))).toBe(true);
    expect(listPendingSkillProposals(vault).some((item) => item.slug === target!.slug)).toBe(false);

    const rerun = learnSkillProposals(vault, {
      now: new Date("2026-06-02T13:00:00Z"),
      minSupport: 3,
    });
    expect(rerun.created.some((id) => id === rejected.id)).toBe(false);
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
