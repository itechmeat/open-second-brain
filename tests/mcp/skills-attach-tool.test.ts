import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuityRecord,
  appendContinuityRecords,
} from "../../src/core/brain/continuity/store.ts";
import * as skillUsage from "../../src/core/brain/skill-usage.ts";
import { resolveSkillsAttachUsageOrdering } from "../../src/core/config.ts";
import { computeSkillOfferId } from "../../src/core/surface/skill-offer.ts";
import { SKILL_TOOLS } from "../../src/mcp/skill-tools.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let configPath: string;
let ctx: ServerContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-attach-tool-"));
  const vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  const skillDir = join(tmp, "skills", "embeddings-setup");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: embeddings-setup\ndescription: Configure embedding providers for semantic search.\n---\n\n# Embeddings",
  );
  ctx = { vault, configPath, repoRoot: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function attach() {
  return SKILL_TOOLS.find((t) => t.name === "skills_attach")!;
}

test("skills_attach is disabled by default (config key absent)", async () => {
  const result = (await attach().handler(ctx, { query: "embedding search" })) as {
    enabled: boolean;
    block: string;
    skills: unknown[];
  };
  expect(result.enabled).toBe(false);
  expect(result.block).toBe("");
  expect(result.skills).toHaveLength(0);
});

test("skills_attach returns a scored block when skill_auto_attach is true", async () => {
  writeFileSync(configPath, `vault: "${ctx.vault}"\nskill_auto_attach: "true"\n`);
  const result = (await attach().handler(ctx, { query: "configure embedding search" })) as {
    enabled: boolean;
    block: string;
    skills: Array<{ name: string; score: number }>;
  };
  expect(result.enabled).toBe(true);
  expect(result.block).toContain("embeddings-setup");
  expect(result.skills[0]!.name).toBe("embeddings-setup");
  expect(result.skills[0]!.score).toBeGreaterThan(0);
});

test("an irrelevant turn attaches nothing even when enabled", async () => {
  writeFileSync(configPath, `vault: "${ctx.vault}"\nskill_auto_attach: "true"\n`);
  const result = (await attach().handler(ctx, { query: "qqq zzz" })) as {
    enabled: boolean;
    block: string;
  };
  expect(result.enabled).toBe(true);
  expect(result.block).toBe("");
});

test("skills_attach is registered in the full tool table", () => {
  expect(() => findTool(buildToolTable("full"), "skills_attach")).not.toThrow();
});

// --- usage-ordered offers (t_5d1ec8a8): the flag and the per-turn wiring ---

const RELEASE_QUERY = "cut the release notes and publish";
const USAGE_FLAG_ENV = "OPEN_SECOND_BRAIN_SKILLS_ATTACH_USAGE_ORDERING";

function writeSkill(name: string, description: string): void {
  const dir = join(tmp, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

/** Two matching release skills (alpha lexically hotter) plus corpus padding. */
function writeReleaseSkills(): void {
  writeSkill(
    "release-alpha",
    "Cut a software release: bump the version, tag, publish and write notes.",
  );
  writeSkill("release-daily", "Cut a software release: bump the version, tag and publish.");
  writeSkill("helper-one", "Tending the garden plants weekly.");
  writeSkill("helper-two", "Author schema vocabulary packs.");
}

function invoke(skill: string, seq: number, at: string): void {
  appendContinuityRecord(ctx.vault, {
    kind: "skill_invoked",
    createdAt: at,
    sourceRefs: [{ id: `sess:${skill}:${seq}` }],
    payload: { skill, agent: "claude", tool: "get_skill" },
  });
}

/** release-daily invoked daily, release-alpha once, years ago. */
function writeUsageRecords(): void {
  for (let i = 1; i <= 5; i++) {
    invoke("release-daily", i, new Date(Date.now() - i * 60_000).toISOString());
  }
  invoke("release-alpha", 1, "2020-01-01T00:00:00Z");
}

function flagConfig(flag: boolean): void {
  writeFileSync(
    configPath,
    `vault: "${ctx.vault}"\nskill_auto_attach: "true"${
      flag ? '\nskills_attach_usage_ordering: "true"' : ""
    }\n`,
  );
}

test("the usage-ordering resolver defaults to off", () => {
  expect(resolveSkillsAttachUsageOrdering(join(tmp, "missing.yaml"))).toBe(false);
});

test("the usage-ordering resolver reads the yaml key, only true or 1 truthy", () => {
  writeFileSync(configPath, 'skills_attach_usage_ordering: "true"\n');
  expect(resolveSkillsAttachUsageOrdering(configPath)).toBe(true);
  writeFileSync(configPath, 'skills_attach_usage_ordering: "yes"\n');
  expect(resolveSkillsAttachUsageOrdering(configPath)).toBe(false);
  writeFileSync(configPath, 'skills_attach_usage_ordering: "1"\n');
  expect(resolveSkillsAttachUsageOrdering(configPath)).toBe(true);
});

test("the usage-ordering env var wins over the yaml key", () => {
  process.env[USAGE_FLAG_ENV] = "true";
  try {
    writeFileSync(configPath, 'skills_attach_usage_ordering: "false"\n');
    expect(resolveSkillsAttachUsageOrdering(configPath)).toBe(true);
  } finally {
    delete process.env[USAGE_FLAG_ENV];
  }
});

test("with the ordering flag off, usage records change nothing (off proof)", async () => {
  writeReleaseSkills();
  writeUsageRecords();
  flagConfig(false);
  const withRecords = (await attach().handler(ctx, { query: RELEASE_QUERY })) as object;
  rmSync(ctx.vault, { recursive: true, force: true });
  mkdirSync(ctx.vault, { recursive: true });
  const withoutRecords = (await attach().handler(ctx, { query: RELEASE_QUERY })) as object;
  expect(JSON.stringify(withRecords)).toBe(JSON.stringify(withoutRecords));
});

test("with the flag on and usage records, the offer reorders and the offer id follows", async () => {
  writeReleaseSkills();
  writeUsageRecords();
  flagConfig(true);
  const result = (await attach().handler(ctx, { query: RELEASE_QUERY })) as {
    offer_id: string | null;
    skills: Array<{ name: string; path: string }>;
  };
  expect(result.skills.map((s) => s.name)).toEqual(["release-daily", "release-alpha"]);
  expect(result.offer_id).toBe(
    computeSkillOfferId(
      RELEASE_QUERY,
      result.skills.map((s) => ({ name: s.name, path: s.path })),
    ),
  );
});

test("with the flag on and an empty vault the offer is byte-identical to off", async () => {
  writeReleaseSkills();
  flagConfig(false);
  const off = (await attach().handler(ctx, { query: RELEASE_QUERY })) as object;
  flagConfig(true);
  const on = (await attach().handler(ctx, { query: RELEASE_QUERY })) as object;
  expect(JSON.stringify(on)).toBe(JSON.stringify(off));
});

test("among recently used skills, the frequently invoked one outranks the once-used one", async () => {
  // Identical descriptors, so the lexical scores are equal and only the usage
  // weight can separate the two; "release-alpha" sorts before "release-daily",
  // so the saturated-weight tie-break the ranking builder replaces would have
  // offered the once-used skill first.
  writeSkill("release-alpha", "Cut a software release: bump the version, tag and publish.");
  writeSkill("release-daily", "Cut a software release: bump the version, tag and publish.");
  writeSkill("helper-one", "Tending the garden plants weekly.");
  writeSkill("helper-two", "Author schema vocabulary packs.");
  appendContinuityRecords(
    ctx.vault,
    Array.from({ length: 300 }, (_, i) => ({
      kind: "skill_invoked" as const,
      createdAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
      sourceRefs: [{ id: `sess:release-daily:${i}` }],
      payload: { skill: "release-daily", agent: "claude", tool: "get_skill" },
    })),
  );
  invoke("release-alpha", 1, new Date(Date.now() - 86_400_000).toISOString());
  flagConfig(true);
  const result = (await attach().handler(ctx, { query: RELEASE_QUERY })) as {
    skills: Array<{ name: string }>;
  };
  expect(result.skills.map((s) => s.name)).toEqual(["release-daily", "release-alpha"]);
});

test("deriveSkillUsage runs exactly once per attach call when on, never when off", async () => {
  writeReleaseSkills();
  writeUsageRecords();
  const spy = spyOn(skillUsage, "deriveSkillUsage");
  try {
    flagConfig(false);
    await attach().handler(ctx, { query: RELEASE_QUERY });
    expect(spy.mock.calls.length).toBe(0);
    flagConfig(true);
    await attach().handler(ctx, { query: RELEASE_QUERY });
    await attach().handler(ctx, { query: RELEASE_QUERY });
    expect(spy.mock.calls.length).toBe(2);
  } finally {
    spy.mockRestore();
  }
});
