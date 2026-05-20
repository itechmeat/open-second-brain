import { describe, expect, test } from "bun:test";
import { renderReport } from "../../src/core/discipline/render.ts";

describe("renderReport", () => {
  test("status: ok with two agents, one repo, vault delta", () => {
    const text = renderReport({
      localDate: "2026-05-17",
      timezone: "Europe/Belgrade",
      status: "ok",
      events: {
        byAgent: {
          "@claude-vps-agent": { feedback: 2, apply_evidence: 3, note: 1, other: 0, total: 6 },
          "@codex-vps-agent": { feedback: 0, apply_evidence: 0, note: 0, other: 0, total: 0 },
        },
        unknownAgents: [],
        total: 6,
      },
      activity: {
        repo: [{ path: "/srv/projects/foo", git: { commits: 4, filesChanged: 27, insertions: 312, deletions: 148 } }],
        nonRepo: [],
        vaultDelta: { newSignals: 1, newPreferences: 0, newRetired: 0, total: 1 },
      },
    });
    expect(text).toContain("OSB discipline");
    expect(text).toContain("2026\\-05\\-17");
    expect(text).toContain("Europe/Belgrade");
    expect(text).toContain("Status: ok");
    expect(text).toContain("@claude\\-vps\\-agent");
    expect(text).toContain("2 feedback, 3 apply\\-evidence, 1 note, 0 other \\(total 6\\)");
    expect(text).toContain("/srv/projects/foo");
    expect(text).toContain("4 commits");
    expect(text).toContain("vault");
    expect(text).not.toContain("Activity ratio");
  });

  test("status: alert appends the explanatory line", () => {
    const text = renderReport({
      localDate: "2026-05-17",
      timezone: "UTC",
      status: "alert",
      events: { byAgent: { "@a": { feedback: 0, apply_evidence: 0, note: 0, other: 0, total: 0 } }, unknownAgents: [], total: 0 },
      activity: {
        repo: [{ path: "/x", git: { commits: 3, filesChanged: 5, insertions: 10, deletions: 2 } }],
        nonRepo: [],
        vaultDelta: { newSignals: 0, newPreferences: 0, newRetired: 0, total: 0 },
      },
    });
    expect(text).toContain("Status: alert");
    expect(text).toContain("zero brain events");
    expect(text).not.toContain("transcript\\-confirmed");
  });

  test("status: alert + transcripts present adds transcript-confirmed sub-reason", () => {
    const text = renderReport({
      localDate: "2026-05-17",
      timezone: "UTC",
      status: "alert",
      events: { byAgent: { "@a": { feedback: 0, apply_evidence: 0, note: 0, other: 0, total: 0 } }, unknownAgents: [], total: 0 },
      activity: {
        repo: [{ path: "/x", git: { commits: 3, filesChanged: 5, insertions: 10, deletions: 2 } }],
        nonRepo: [],
        vaultDelta: { newSignals: 0, newPreferences: 0, newRetired: 0, total: 0 },
        transcripts: {
          byRuntime: [
            { runtime: "claudecode", fileCount: 2, agentHint: "claude-vps-agent" },
            { runtime: "codex", fileCount: 0, agentHint: "codex-vps-agent" },
          ],
          totalFiles: 2,
        },
      },
    });
    expect(text).toContain("Status: alert");
    expect(text).toContain("transcripts — claudecode: 2");
    expect(text).toContain("transcript\\-confirmed");
  });

  test("transcripts with zero files omit the line and skip the sub-reason", () => {
    const text = renderReport({
      localDate: "2026-05-17",
      timezone: "UTC",
      status: "alert",
      events: { byAgent: { "@a": { feedback: 0, apply_evidence: 0, note: 0, other: 0, total: 0 } }, unknownAgents: [], total: 0 },
      activity: {
        repo: [{ path: "/x", git: { commits: 1, filesChanged: 1, insertions: 1, deletions: 0 } }],
        nonRepo: [],
        vaultDelta: { newSignals: 0, newPreferences: 0, newRetired: 0, total: 0 },
        transcripts: {
          byRuntime: [
            { runtime: "claudecode", fileCount: 0, agentHint: "claude-vps-agent" },
          ],
          totalFiles: 0,
        },
      },
    });
    expect(text).not.toContain("transcripts —");
    expect(text).not.toContain("transcript\\-confirmed");
  });
});
