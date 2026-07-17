import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SKILL_TOOLS } from "../../src/mcp/skill-tools.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let ctx: ServerContext;

function writeSkill(repoRoot: string, dir: string, description: string, body: string): void {
  const skillDir = join(repoRoot, "skills", dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${dir}\ndescription: ${description}\n---\n\n${body}`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-skill-tools-"));
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  writeSkill(tmp, "demo-skill", "Demonstration skill.", "# Demo\n\nUse wisely.");
  writeSkill(tmp, "other-skill", "Another skill.", "# Other");
  ctx = { vault, configPath: null, repoRoot: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tool(name: string) {
  return SKILL_TOOLS.find((t) => t.name === name)!;
}

test("list_skills returns sorted names with descriptions and paths", async () => {
  const result = (await tool("list_skills").handler(ctx, {})) as {
    skills: Array<{ name: string; description: string; path: string }>;
    count: number;
  };
  expect(result.count).toBe(2);
  expect(result.skills.map((s) => s.name)).toEqual(["demo-skill", "other-skill"]);
  expect(result.skills[0]!.description).toBe("Demonstration skill.");
  expect(result.skills[0]!.path).toContain("skills/demo-skill");
});

test("list_skills with no roots fails soft to an empty list", async () => {
  const bare: ServerContext = { vault: join(tmp, "ghost"), configPath: null, repoRoot: null };
  const result = (await tool("list_skills").handler(bare, {})) as { count: number };
  expect(result.count).toBe(0);
});

test("get_skill returns SKILL.md content by name", async () => {
  const result = (await tool("get_skill").handler(ctx, { name: "demo-skill" })) as {
    name: string;
    content: string;
  };
  expect(result.name).toBe("demo-skill");
  expect(result.content).toContain("Use wisely.");
});

test("get_skill reads an auxiliary file inside the skill directory", async () => {
  writeFileSync(join(tmp, "skills", "demo-skill", "ref.md"), "reference text");
  const result = (await tool("get_skill").handler(ctx, {
    name: "demo-skill",
    file_path: "ref.md",
  })) as { content: string };
  expect(result.content).toBe("reference text");
});

test("get_skill rejects unknown skills and traversal paths", () => {
  expect(() => tool("get_skill").handler(ctx, { name: "nope" })).toThrow("unknown skill");
  expect(() =>
    tool("get_skill").handler(ctx, { name: "demo-skill", file_path: "../other-skill/SKILL.md" }),
  ).toThrow("inside the skill directory");
});

test("skill tools are registered in the full tool table", () => {
  const tools = buildToolTable("full");
  expect(() => findTool(tools, "list_skills")).not.toThrow();
  expect(() => findTool(tools, "get_skill")).not.toThrow();
});
