/**
 * Doctor `removed-tool-reference` check (1.0.0 deprecation sweep,
 * epic t_a77ade0a): vault-side surfaces the doctor can actually see -
 * Brain notes, root instruction files, installed skill files - are
 * scanned for the 18 tool names removed in 1.0.0. Each hit yields one
 * warning naming the replacement so an operator updating an old vault
 * learns the migration without reading the upgrade guide first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-removed-"));
  const dirs = brainDirs(vault);
  mkdirSync(dirs.brain, { recursive: true });
  mkdirSync(dirs.preferences, { recursive: true });
  mkdirSync(dirs.log, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function removedToolWarnings(): ReadonlyArray<{ code: string; message: string }> {
  return runDoctor(vault).warnings.filter((w) => w.code === "removed-tool-reference");
}

describe("removed-tool-reference doctor check", () => {
  test("clean vault yields no removed-tool warnings", () => {
    writeFileSync(join(vault, "Brain", "note.md"), "# Note\n\nCall brain_brief for digests.\n");
    expect(removedToolWarnings()).toEqual([]);
  });

  test("a Brain note referencing a removed tool warns with the replacement", () => {
    writeFileSync(
      join(vault, "Brain", "playbook.md"),
      "# Playbook\n\nEvery morning call brain_digest and read it.\n",
    );
    const warnings = removedToolWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("Brain/playbook.md");
    expect(warnings[0]!.message).toContain("brain_digest");
    expect(warnings[0]!.message).toContain("brain_brief");
    expect(warnings[0]!.message).toContain('view="digest"');
  });

  test("root instruction files are scanned", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "Use schema_stats to check usage.\n");
    const warnings = removedToolWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("CLAUDE.md");
    expect(warnings[0]!.message).toContain("schema_inspect");
  });

  test("installed skill files are scanned", () => {
    const skillDir = join(vault, ".claude", "skills", "old-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "Call brain_operator_summary for status.\n");
    const warnings = removedToolWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("brain_operator_summary");
    expect(warnings[0]!.message).toContain('view="operator"');
  });

  test("multiple removed names in one file fold into one warning per file", () => {
    writeFileSync(
      join(vault, "Brain", "old-howto.md"),
      "Use brain_digest then brain_timeline then schema_lint.\n",
    );
    const warnings = removedToolWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("brain_digest");
    expect(warnings[0]!.message).toContain("brain_timeline");
    expect(warnings[0]!.message).toContain("schema_lint");
  });

  test("substring matches do not fire (word boundary)", () => {
    // `my_brain_digestion` must not match `brain_digest`.
    writeFileSync(join(vault, "Brain", "note.md"), "my_brain_digestion is a variable name\n");
    expect(removedToolWarnings()).toEqual([]);
  });
});
