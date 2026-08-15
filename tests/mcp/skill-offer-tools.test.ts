/**
 * Skill tool surface for the offer chain (Unit J, t_ccb05134).
 *
 * `skills_attach` hands back the id of the offer it just made, `get_skill`
 * accepts that id so the runtime's session log records which offer the
 * invocation came from, and `list_skills` surfaces the paths a skill
 * shadows. No new tool is added, so the registry guard's preview-budget
 * contract is unaffected; it is asserted once over the whole table in
 * `registry-guard.test.ts`, and re-asserting it here only meant two
 * places to update when the table changes.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SKILL_TOOLS } from "../../src/mcp/skill-tools.ts";
import { isSkillOfferId, SKILL_OFFER_ID_KEY } from "../../src/core/surface/skill-offer.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let configPath: string;
let ctx: ServerContext;

function writeSkill(root: string, dir: string, name: string, description: string): string {
  const skillDir = join(root, dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.`,
  );
  return skillDir;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-skill-offer-tools-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\nskill_auto_attach: "true"\n`);
  writeSkill(join(tmp, "skills"), "embeddings-setup", "embeddings-setup", "Configure embeddings.");
  ctx = { vault, configPath, repoRoot: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tool(name: string) {
  return SKILL_TOOLS.find((t) => t.name === name)!;
}

test("skills_attach returns the id of the offer it just made", async () => {
  const result = (await tool("skills_attach").handler(ctx, { query: "configure embeddings" })) as {
    enabled: boolean;
    offer_id: string | null;
    block: string;
  };
  expect(result.enabled).toBe(true);
  expect(isSkillOfferId(result.offer_id)).toBe(true);
  expect(result.block).toContain(result.offer_id!);
});

test("a turn that is offered nothing gets no offer id", async () => {
  const result = (await tool("skills_attach").handler(ctx, { query: "qqq zzz" })) as {
    enabled: boolean;
    offer_id: string | null;
  };
  expect(result.enabled).toBe(true);
  expect(result.offer_id).toBeNull();
});

test("the disabled surface reports no offer, exactly as it reports no block", async () => {
  writeFileSync(configPath, `vault: "${vault}"\n`);
  const result = (await tool("skills_attach").handler(ctx, { query: "configure embeddings" })) as {
    enabled: boolean;
    block: string;
    offer_id: string | null;
    skills: unknown[];
  };
  expect(result.enabled).toBe(false);
  expect(result.block).toBe("");
  expect(result.skills).toHaveLength(0);
  expect(result.offer_id).toBeNull();
});

test("get_skill echoes the offer the caller cited so the session log carries it", async () => {
  const offered = (await tool("skills_attach").handler(ctx, { query: "configure embeddings" })) as {
    offer_id: string;
  };
  const result = (await tool("get_skill").handler(ctx, {
    name: "embeddings-setup",
    [SKILL_OFFER_ID_KEY]: offered.offer_id,
  })) as Record<string, unknown>;
  expect(result[SKILL_OFFER_ID_KEY]).toBe(offered.offer_id);
});

test("get_skill without an offer id omits the key rather than inventing one", async () => {
  const result = (await tool("get_skill").handler(ctx, {
    name: "embeddings-setup",
  })) as Record<string, unknown>;
  expect(SKILL_OFFER_ID_KEY in result).toBe(false);
});

test("get_skill refuses a malformed offer id instead of recording a fiction", () => {
  expect(() =>
    tool("get_skill").handler(ctx, { name: "embeddings-setup", [SKILL_OFFER_ID_KEY]: "nope" }),
  ).toThrow("offer_id");
});

test("get_skill declares offer_id in its input schema", () => {
  const schema = tool("get_skill").inputSchema as {
    properties: Record<string, { type: string; description: string }>;
  };
  expect(schema.properties[SKILL_OFFER_ID_KEY]!.type).toBe("string");
  expect(schema.properties[SKILL_OFFER_ID_KEY]!.description.length).toBeLessThanOrEqual(160);
});

test("list_skills surfaces the paths a skill shadows", async () => {
  const vaultSkills = join(vault, "Brain", "skills");
  const shadowed = join(tmp, "skills", "embeddings-setup");
  writeSkill(vaultSkills, "embeddings-setup", "embeddings-setup", "Operator override.");

  const result = (await tool("list_skills").handler(ctx, {})) as {
    skills: Array<{ name: string; description: string; shadowed: string[] }>;
  };
  expect(result.skills).toHaveLength(1);
  expect(result.skills[0]!.description).toBe("Operator override.");
  expect(result.skills[0]!.shadowed).toEqual([shadowed]);
});

test("an unshadowed skill reports an empty shadowed list", async () => {
  const result = (await tool("list_skills").handler(ctx, {})) as {
    skills: Array<{ shadowed: string[] }>;
  };
  expect(result.skills[0]!.shadowed).toEqual([]);
});
