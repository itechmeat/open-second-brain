import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { proposalWatermarkPath } from "../../../src/core/brain/paths.ts";
import {
  learnSkillProposals,
  listPendingSkillProposals,
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
    };
    expect(wm.lastCreatedAt).toBe(first.watermarkTo);

    const second = learnSkillProposals(vault, {
      now: new Date("2026-06-01T11:00:00Z"),
      minSupport: 3,
    });
    expect(second.scanned).toBe(0);
    expect(second.created).toHaveLength(0);
    expect(listPendingSkillProposals(vault).length).toBe(first.created.length);
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
