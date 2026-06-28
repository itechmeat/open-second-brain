/**
 * Skill surface MCP tools (Agent Surface Suite).
 *
 * `list_skills` / `get_skill` let any MCP-connected agent discover and
 * load the skills Open Second Brain ships in `skills/` (plus optional
 * vault-local skills under `Brain/skills/`) without shell access or
 * prior knowledge of skill names. `skills_attach` is the deterministic
 * per-turn relevance surface: gated by the `skill_auto_attach` config
 * key (default off), it scores skills against the current turn text
 * with the shared lexical scorer and returns a char-budgeted block.
 */

import { resolveSkillAutoAttach, resolveSkillsDir } from "../core/config.ts";
import { buildSkillAttachment } from "../core/surface/skill-attach.ts";
import { discoverSkills, readSkillFile, skillRoots, SkillError } from "../core/surface/skills.ts";
import { coerceInt, coerceStr } from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tools.ts";

function rootsFor(ctx: ServerContext): string[] {
  const skillsDir = resolveSkillsDir(ctx.configPath ?? undefined);
  return skillRoots({ repoRoot: ctx.repoRoot, vault: ctx.vault, skillsDir });
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

function toolSkillsAttach(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const query = coerceStr(args, "query", true)!;
  const maxSkills = coerceInt(args, "max_skills", 3, 1, 10);
  if (!resolveSkillAutoAttach(ctx.configPath ?? undefined)) {
    return { enabled: false, block: "", skills: [] };
  }
  const attachment = buildSkillAttachment({
    query,
    skills: discoverSkills(rootsFor(ctx)),
    maxSkills,
  });
  return {
    enabled: true,
    block: attachment.block,
    skills: attachment.items.map((item) => ({
      name: item.name,
      description: item.description,
      path: item.path,
      score: item.score,
    })),
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
  {
    name: "skills_attach",
    description:
      "Score available skills against the current turn text and return a char-budgeted block of relevant skill summaries. Returns enabled:false unless skill_auto_attach is configured.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Current turn text to score skills against.",
        },
        max_skills: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of skills to attach (default 3).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: (ctx, args) => toolSkillsAttach(ctx, args),
  },
];
