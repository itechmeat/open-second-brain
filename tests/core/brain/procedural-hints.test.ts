import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readProceduralHints,
  rebuildProceduralHints,
} from "../../../src/core/brain/procedural-hints.ts";
import { rebuildProceduralGraph } from "../../../src/core/brain/procedural-graph.ts";
import { reconcileProceduralMemory } from "../../../src/core/brain/procedural-memory.ts";

let vault: string;

beforeEach(() => {
  vault = join(
    tmpdir(),
    `o2b-procedural-hints-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("procedural hints projection", () => {
  test("builds deterministic hint cues from graph nodes", () => {
    seedSources(vault);
    reconcileProceduralMemory(vault, {
      roots: [join(vault, "Brain", "procedures"), join(vault, "skills")],
    });
    const graph = rebuildProceduralGraph(vault, {
      now: new Date("2026-06-02T12:00:00Z"),
    });

    const hints = rebuildProceduralHints(vault, {
      graph,
      now: new Date("2026-06-02T12:01:00Z"),
    });

    expect(hints.schema_version).toBe(1);
    expect(hints.generated_at).toBe("2026-06-02T12:01:00.000Z");
    expect(hints.entries.length).toBeGreaterThan(0);

    const first = hints.entries[0]!;
    expect(first.cues.length).toBeGreaterThan(0);
  });

  test("returns null when no projection exists", () => {
    expect(readProceduralHints(vault)).toBeNull();
  });
});

function seedSources(vaultPath: string): void {
  const proceduresDir = join(vaultPath, "Brain", "procedures");
  const skillsDir = join(vaultPath, "skills", "release");
  mkdirSync(proceduresDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  writeFileSync(
    join(proceduresDir, "proc-release-notes.md"),
    [
      "---",
      "kind: brain-procedure",
      "triggers: [release, changelog]",
      "tags: [ops, docs]",
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
}
