/**
 * Shadowed-skill provenance (Unit J, t_ccb05134, decision J3).
 *
 * Same-named skills already collapse on a name key in `discoverSkills`, so
 * duplicates never reach the ranker. The defect is the other half of that
 * collapse: the losing skill's path was dropped on the floor, so an operator
 * reading a surprising skill body had nothing telling them a second copy
 * exists. The winner now carries the paths it shadows.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSkills } from "../../../src/core/surface/skills.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-skill-shadow-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(root: string, dir: string, frontmatter: string): string {
  const skillDir = join(root, dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\nBody.`);
  return skillDir;
}

test("the winning skill records the path it shadowed instead of discarding it", () => {
  const repo = join(tmp, "repo-skills");
  const vault = join(tmp, "vault-skills");
  const shadowedDir = writeSkill(repo, "shared", "name: shared\ndescription: repo copy");
  const winnerDir = writeSkill(vault, "shared", "name: shared\ndescription: vault copy");

  const skills = discoverSkills([repo, vault]);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.path).toBe(winnerDir);
  expect(skills[0]!.description).toBe("vault copy");
  expect(skills[0]!.shadowed).toEqual([shadowedDir]);
});

test("every shadowed path is kept, in discovery order", () => {
  const first = join(tmp, "a-skills");
  const second = join(tmp, "b-skills");
  const third = join(tmp, "c-skills");
  const firstDir = writeSkill(first, "shared", "name: shared\ndescription: first");
  const secondDir = writeSkill(second, "shared", "name: shared\ndescription: second");
  const thirdDir = writeSkill(third, "shared", "name: shared\ndescription: third");

  const skills = discoverSkills([first, second, third]);
  expect(skills[0]!.path).toBe(thirdDir);
  expect(skills[0]!.shadowed).toEqual([firstDir, secondDir]);
});

test("an unshadowed skill reports an empty list, not an absent one", () => {
  // Empty means "checked, nothing shadowed". Absent would mean the entry
  // never went through discovery, which is a different answer.
  const root = join(tmp, "skills");
  writeSkill(root, "solo", "name: solo\ndescription: only copy");
  expect(discoverSkills([root])[0]!.shadowed).toEqual([]);
});

test("shadowing keys on the skill name, not the directory name", () => {
  const first = join(tmp, "a-skills");
  const second = join(tmp, "b-skills");
  writeSkill(first, "same-dir", "name: alpha\ndescription: a");
  writeSkill(second, "same-dir", "name: beta\ndescription: b");
  const skills = discoverSkills([first, second]);
  expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
  for (const skill of skills) expect(skill.shadowed).toEqual([]);
});

test("a same-named skill inside one root shadows within that root too", () => {
  const root = join(tmp, "skills");
  const dupA = writeSkill(root, "aaa", "name: shared\ndescription: from aaa");
  const dupB = writeSkill(root, "bbb", "name: shared\ndescription: from bbb");
  const skills = discoverSkills([root]);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.path).toBe(dupB);
  expect(skills[0]!.shadowed).toEqual([dupA]);
});
