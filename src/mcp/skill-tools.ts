/**
 * Skill surface MCP tools (Agent Surface Suite).
 *
 * `list_skills` / `get_skill` let any MCP-connected agent discover and
 * load the skills Open Second Brain ships in `skills/` (plus optional
 * vault-local skills under `Brain/skills/`) without shell access or
 * prior knowledge of skill names.
 */

import { discoverSkills, readSkillFile, skillRoots, SkillError } from "../core/surface/skills.ts";
import { coerceStr } from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tools.ts";

function rootsFor(ctx: ServerContext): string[] {
  return skillRoots({ repoRoot: ctx.repoRoot, vault: ctx.vault });
}

function toolListSkills(ctx: ServerContext): Record<string, unknown> {
  const skills = discoverSkills(rootsFor(ctx));
  return {
    count: skills.length,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      path: s.path,
    })),
  };
}

function toolGetSkill(ctx: ServerContext, args: Record<string, unknown>): Record<string, unknown> {
  const name = coerceStr(args, "name", true)!;
  const filePath = coerceStr(args, "file_path", false) ?? undefined;
  const skills = discoverSkills(rootsFor(ctx));
  const skill = skills.find((s) => s.name === name);
  if (skill === undefined) {
    const known = skills.map((s) => s.name).join(", ") || "(none)";
    throw new MCPError(INVALID_PARAMS, `unknown skill: ${name}. Known skills: ${known}`);
  }
  let content: string;
  try {
    content = readSkillFile(skill, filePath);
  } catch (err) {
    if (err instanceof SkillError) throw new MCPError(INVALID_PARAMS, err.message);
    throw err;
  }
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    ...(filePath !== undefined ? { file_path: filePath } : {}),
    content,
  };
}

export const SKILL_TOOLS: ReadonlyArray<ToolDefinition> = [
  {
    name: "list_skills",
    description:
      "List agent skills shipped with Open Second Brain (and vault-local Brain/skills/) with one-line descriptions. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: (ctx) => toolListSkills(ctx),
  },
  {
    name: "get_skill",
    description:
      "Fetch a skill's SKILL.md content by name; optional file_path reads an auxiliary file inside the same skill directory. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name as returned by list_skills.",
        },
        file_path: {
          type: "string",
          description: "Optional relative path to an auxiliary file inside the skill directory.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: (ctx, args) => toolGetSkill(ctx, args),
  },
];
