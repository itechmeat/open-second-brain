import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverSkills,
  readSkillFile,
  skillRoots,
  SkillError,
} from "../../../src/core/surface/skills.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-skills-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(root: string, dir: string, frontmatter: string | null, body: string): string {
  const skillDir = join(root, dir);
  mkdirSync(skillDir, { recursive: true });
  const content = frontmatter === null ? body : `---\n${frontmatter}\n---\n\n${body}`;
  writeFileSync(join(skillDir, "SKILL.md"), content);
  return skillDir;
}

test("discoverSkills reads frontmatter name and description", () => {
  const root = join(tmp, "skills");
  writeSkill(
    root,
    "alpha",
    'name: alpha-skill\ndescription: "Does alpha things."',
    "# Alpha\n\nBody.",
  );
  const skills = discoverSkills([root]);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("alpha-skill");
  expect(skills[0]!.description).toBe("Does alpha things.");
});

test("parses a scalar triggers field into the flattened keyword string", () => {
  const root = join(tmp, "skills");
  writeSkill(
    root,
    "agent-search",
    'name: agent-search\ndescription: "Search."\ntriggers: "research lookup 调研"',
    "# Search",
  );
  expect(discoverSkills([root])[0]!.triggers).toBe("research lookup 调研");
});

test("parses an inline-array triggers field by joining on space", () => {
  const root = join(tmp, "skills");
  writeSkill(
    root,
    "agent-search",
    "name: agent-search\ndescription: d\ntriggers: [research, lookup, 调研]",
    "# Search",
  );
  expect(discoverSkills([root])[0]!.triggers).toBe("research lookup 调研");
});

test("a skill without a triggers field exposes an empty triggers string", () => {
  const root = join(tmp, "skills");
  writeSkill(root, "plain", "name: plain\ndescription: d", "# Plain");
  expect(discoverSkills([root])[0]!.triggers).toBe("");
});

test("falls back to directory name and first body line without frontmatter", () => {
  const root = join(tmp, "skills");
  writeSkill(root, "bare", null, "# Bare Skill\n\nFirst real paragraph line.\n\nMore.");
  const skills = discoverSkills([root]);
  expect(skills[0]!.name).toBe("bare");
  expect(skills[0]!.description).toBe("First real paragraph line.");
});

test("skills sort by name and a directory without SKILL.md is skipped", () => {
  const root = join(tmp, "skills");
  writeSkill(root, "zeta", "name: zeta\ndescription: z", "z");
  writeSkill(root, "alpha", "name: alpha\ndescription: a", "a");
  mkdirSync(join(root, "not-a-skill"), { recursive: true });
  const skills = discoverSkills([root]);
  expect(skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
});

test("a later root overrides an earlier one on name collision", () => {
  const repo = join(tmp, "repo-skills");
  const vault = join(tmp, "vault-skills");
  writeSkill(repo, "shared", "name: shared\ndescription: repo copy", "r");
  writeSkill(vault, "shared", "name: shared\ndescription: vault copy", "v");
  const skills = discoverSkills([repo, vault]);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.description).toBe("vault copy");
});

test("missing roots fail soft to an empty list", () => {
  expect(discoverSkills([join(tmp, "nope")])).toEqual([]);
  expect(discoverSkills([])).toEqual([]);
});

test("skillRoots returns existing repo and vault roots only", () => {
  const repoRoot = join(tmp, "repo");
  mkdirSync(join(repoRoot, "skills"), { recursive: true });
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "skills"), { recursive: true });
  expect(skillRoots({ repoRoot, vault })).toEqual([
    join(repoRoot, "skills"),
    join(vault, "Brain", "skills"),
  ]);
  expect(skillRoots({ repoRoot: join(tmp, "ghost"), vault: null })).toEqual([]);
});

test("skillsDir overrides the vault-local Brain/skills root", () => {
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "skills"), { recursive: true });
  const external = join(tmp, "external-skills");
  mkdirSync(external, { recursive: true });
  // With skillsDir set, the vault-local path is replaced, not appended.
  expect(skillRoots({ vault, skillsDir: external })).toEqual([external]);
});

test("skillsDir alongside repoRoot keeps the repo root and replaces the vault root", () => {
  const repoRoot = join(tmp, "repo");
  mkdirSync(join(repoRoot, "skills"), { recursive: true });
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "skills"), { recursive: true });
  const external = join(tmp, "external-skills");
  mkdirSync(external, { recursive: true });
  expect(skillRoots({ repoRoot, vault, skillsDir: external })).toEqual([
    join(repoRoot, "skills"),
    external,
  ]);
});

test("a non-existent skillsDir falls soft to an empty root list", () => {
  expect(skillRoots({ vault: null, skillsDir: join(tmp, "ghost-skills") })).toEqual([]);
});

test("readSkillFile returns SKILL.md by default and auxiliary files by relative path", () => {
  const root = join(tmp, "skills");
  const dir = writeSkill(root, "rich", "name: rich\ndescription: r", "# Rich");
  writeFileSync(join(dir, "extra.md"), "extra content");
  const [skill] = discoverSkills([root]);
  expect(readSkillFile(skill!)).toContain("# Rich");
  expect(readSkillFile(skill!, "extra.md")).toBe("extra content");
});

test("readSkillFile rejects traversal and absolute paths", () => {
  const root = join(tmp, "skills");
  writeSkill(root, "guarded", "name: guarded\ndescription: g", "g");
  const [skill] = discoverSkills([root]);
  expect(() => readSkillFile(skill!, "../other/SKILL.md")).toThrow(SkillError);
  expect(() => readSkillFile(skill!, "/etc/passwd")).toThrow(SkillError);
});

test("readSkillFile refuses a symlink that escapes the skill directory", () => {
  const root = join(tmp, "skills");
  const dir = writeSkill(root, "linked", "name: linked\ndescription: l", "l");
  writeFileSync(join(tmp, "outside-secret.txt"), "secret");
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  symlinkSync(join(tmp, "outside-secret.txt"), join(dir, "escape.md"));
  const [skill] = discoverSkills([root]);
  expect(() => readSkillFile(skill!, "escape.md")).toThrow(SkillError);
});

test("readSkillFile throws NOT_FOUND for a missing auxiliary file", () => {
  const root = join(tmp, "skills");
  writeSkill(root, "sparse", "name: sparse\ndescription: s", "s");
  const [skill] = discoverSkills([root]);
  expect(() => readSkillFile(skill!, "missing.md")).toThrow(SkillError);
});
