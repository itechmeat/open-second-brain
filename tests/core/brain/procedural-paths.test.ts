import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  procedurePath,
  proceduralMemoryIndexPath,
  proceduralMemoryUsagePath,
  proceduralRecurrencePath,
  skillProposalAcceptedPath,
  skillProposalPendingPath,
  skillProposalRejectedPath,
} from "../../../src/core/brain/paths.ts";

describe("procedural learning paths", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("builds vault-contained paths for proposal/procedure/index artifacts", () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-procedural-paths-"));
    tmpRoots.push(vault);

    const pending = skillProposalPendingPath(vault, "release-notes");
    const accepted = skillProposalAcceptedPath(vault, "release-notes");
    const rejected = skillProposalRejectedPath(vault, "release-notes");
    const procedure = procedurePath(vault, "release-notes");
    const index = proceduralMemoryIndexPath(vault);
    const usage = proceduralMemoryUsagePath(vault);
    const recurrence = proceduralRecurrencePath(vault);

    expect(pending).toBe(
      join(vault, "Brain", "skill-proposals", "pending", "prop-release-notes.md"),
    );
    expect(accepted).toBe(
      join(vault, "Brain", "skill-proposals", "accepted", "prop-release-notes.md"),
    );
    expect(rejected).toBe(
      join(vault, "Brain", "skill-proposals", "rejected", "prop-release-notes.md"),
    );
    expect(procedure).toBe(join(vault, "Brain", "procedures", "proc-release-notes.md"));
    expect(index).toBe(join(vault, "Brain", "procedural-memory", "index.json"));
    expect(usage).toBe(join(vault, "Brain", "procedural-memory", "usage.jsonl"));
    expect(recurrence).toBe(join(vault, "Brain", "log", "recurrence-support.jsonl"));
  });

  test("rejects unsafe slug input for proposal and procedure paths", () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-procedural-paths-"));
    tmpRoots.push(vault);

    expect(() => skillProposalPendingPath(vault, "../escape")).toThrow(/slug must not contain/);
    expect(() => procedurePath(vault, "bad/slug")).toThrow(/slug must not contain path separators/);
  });
});
