import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listProceduralMemory,
  markProceduralMemoryUsed,
  reconcileProceduralMemory,
} from "../../../src/core/brain/procedural-memory.ts";
import { proceduralMemoryUsagePath } from "../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = join(
    tmpdir(),
    `o2b-procedural-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("procedural memory reconciler", () => {
  test("parses metadata, updates on source changes, and removes stale entries", () => {
    const roots = seedProceduralSources(vault);

    const first = reconcileProceduralMemory(vault, { roots });
    expect(first.total).toBe(2);
    expect(first.added).toBe(2);

    const listed = listProceduralMemory(vault);
    const skill = listed.find((entry) => entry.kind === "skill");
    expect(skill).toBeDefined();
    expect(skill?.triggers).toContain("release");
    expect(skill?.tags).toContain("ops");

    writeFileSync(
      join(vault, "skills", "release", "SKILL.md"),
      [
        "---",
        "version: 2",
        "triggers: [release, changelog]",
        "tags: [ops, ci]",
        "permissions: [read, write]",
        "source: test-suite",
        "---",
        "# Release Skill",
      ].join("\n") + "\n",
      "utf8",
    );

    const second = reconcileProceduralMemory(vault, { roots });
    expect(second.updated).toBeGreaterThanOrEqual(1);

    rmSync(join(vault, "Brain", "procedures", "proc-release-notes.md"));
    const third = reconcileProceduralMemory(vault, { roots });
    expect(third.removed).toBe(1);
    expect(
      listProceduralMemory(vault).some((entry) =>
        entry.sourcePath.includes("proc-release-notes.md"),
      ),
    ).toBe(false);
  });

  test("usage tracking updates sidecar/index without rewriting source files", () => {
    const roots = seedProceduralSources(vault);
    reconcileProceduralMemory(vault, { roots });

    const sourcePath = join(vault, "skills", "release", "SKILL.md");
    const beforeSource = readFileSync(sourcePath, "utf8");
    const beforeStat = statSync(sourcePath).mtimeMs;

    const entry = listProceduralMemory(vault).find((item) => item.kind === "skill");
    expect(entry).toBeDefined();

    const updated = markProceduralMemoryUsed(vault, entry!.id, new Date("2026-06-01T15:00:00Z"));
    expect(updated?.usedCount).toBe(1);
    expect(updated?.lastUsedAt).toBe("2026-06-01T15:00:00.000Z");

    const afterSource = readFileSync(sourcePath, "utf8");
    const afterStat = statSync(sourcePath).mtimeMs;
    expect(afterSource).toBe(beforeSource);
    expect(afterStat).toBe(beforeStat);

    const usage = readFileSync(proceduralMemoryUsagePath(vault), "utf8");
    expect(usage).toContain(entry!.id);
  });
});

function seedProceduralSources(vaultPath: string): string[] {
  const proceduresDir = join(vaultPath, "Brain", "procedures");
  const skillsDir = join(vaultPath, "skills", "release");
  mkdirSync(proceduresDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  writeFileSync(
    join(proceduresDir, "proc-release-notes.md"),
    [
      "---",
      "kind: brain-procedure",
      "tags: [docs, release]",
      "triggers: [release]",
      "---",
      "# Release notes procedure",
    ].join("\n") + "\n",
    "utf8",
  );

  writeFileSync(
    join(skillsDir, "SKILL.md"),
    [
      "---",
      "version: 1",
      "triggers: [release]",
      "tags: [ops]",
      "permissions: [read]",
      "source: test-suite",
      "---",
      "# Release Skill",
    ].join("\n") + "\n",
    "utf8",
  );

  return [join(vaultPath, "Brain", "procedures"), join(vaultPath, "skills")];
}
