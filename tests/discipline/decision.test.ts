import { describe, expect, test } from "bun:test";
import { decideStatus } from "../../src/core/discipline/decision.ts";

describe("decideStatus", () => {
  const noEvents = { byAgent: {}, unknownAgents: [], total: 0 } as any;
  const someTasteEvents = {
    byAgent: {
      "@a": { feedback: 2, apply_evidence: 3, other: 0, total: 5 },
    },
    unknownAgents: [],
    total: 5,
  } as any;
  const onlyOtherEvents = {
    byAgent: {
      "@a": { feedback: 0, apply_evidence: 0, other: 4, total: 4 },
    },
    unknownAgents: [],
    total: 4,
  } as any;
  const noActivity = {
    repo: [],
    nonRepo: [],
    vaultDelta: { newSignals: 0, newPreferences: 0, newRetired: 0, total: 0 },
  } as any;
  const someRepoActivity = {
    ...noActivity,
    repo: [
      {
        path: "/a",
        git: { commits: 2, filesChanged: 1, insertions: 1, deletions: 0 },
      },
    ],
  };
  const someMtimeActivity = {
    ...noActivity,
    nonRepo: [{ path: "/b", modifiedFiles: 5 }],
  };
  const someVaultDelta = {
    ...noActivity,
    vaultDelta: { newSignals: 0, newPreferences: 1, newRetired: 0, total: 1 },
  };
  const highComplexity = {
    ...noActivity,
    complexity: {
      schema_version: 1,
      generated_at: "2026-05-28T00:00:00.000Z",
      score: 12,
      ratio: 12,
      thinking_activity: 0,
      structural_complexity: 12,
      warning: true,
      factors: [{ name: "structure_churn", value: 12, weight: 1 }],
    },
  } as any;

  test("0 events + 0 activity → info", () => {
    expect(decideStatus(noEvents, noActivity)).toBe("info");
  });
  test("0 events + repo activity → alert", () => {
    expect(decideStatus(noEvents, someRepoActivity)).toBe("alert");
  });
  test("0 events + mtime activity (>=3) → alert", () => {
    expect(decideStatus(noEvents, someMtimeActivity)).toBe("alert");
  });
  test("0 events + mtime activity (<3) → info", () => {
    const low = { ...noActivity, nonRepo: [{ path: "/b", modifiedFiles: 2 }] };
    expect(decideStatus(noEvents, low)).toBe("info");
  });
  test("0 events + vault delta → alert", () => {
    expect(decideStatus(noEvents, someVaultDelta)).toBe("alert");
  });
  test("0 events + high complexity-to-thinking ratio → alert", () => {
    expect(decideStatus(noEvents, highComplexity)).toBe("alert");
  });
  test("taste events present (feedback or apply_evidence) → ok regardless of activity", () => {
    expect(decideStatus(someTasteEvents, noActivity)).toBe("ok");
    expect(decideStatus(someTasteEvents, someRepoActivity)).toBe("ok");
    expect(decideStatus(someTasteEvents, highComplexity)).toBe("ok");
  });

  test("only `other` events (snapshot/dream/import) do NOT count as taste → alert if activity", () => {
    // This is the regression catch: a snapshot or import-claude-memory
    // event on a busy code day previously suppressed the alert.
    expect(decideStatus(onlyOtherEvents, someRepoActivity)).toBe("alert");
    expect(decideStatus(onlyOtherEvents, noActivity)).toBe("info");
  });
});
