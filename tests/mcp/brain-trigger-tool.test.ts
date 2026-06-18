/**
 * `brain_trigger` MCP tool + morning-brief trigger section (Workspace
 * Insight Suite, t_cd1fee79).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import type { InsightCandidate } from "../../src/core/brain/triggers/types.ts";
import { buildToolTable, findTool, type ServerContext } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let ctx: ServerContext;
const NOW = new Date();

const CANDIDATE: InsightCandidate = {
  kind: "contradiction",
  urgency: "high",
  reason: "pref-a contradicts pref-b",
  suggestedAction: "Review the pair",
  sourceArtifacts: ["[[pref-a]]"],
  contextSnippets: [],
  cooldownKey: "contradiction:pref-a:pref-b",
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-trigger-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tool(name: string) {
  return findTool(buildToolTable("full"), name);
}

test("brain_trigger list/acknowledge/act round-trip", async () => {
  const { created } = createTriggers(vault, [CANDIDATE], { now: NOW });
  const id = created[0]!.id;

  const listed = (await tool("brain_trigger").handler(ctx, { operation: "list" })) as {
    triggers: Array<{ id: string; status: string }>;
  };
  expect(listed.triggers.map((t) => t.id)).toEqual([id]);

  const acked = (await tool("brain_trigger").handler(ctx, {
    operation: "acknowledge",
    id,
  })) as { trigger: { status: string } };
  expect(acked.trigger.status).toBe("acknowledged");

  const acted = (await tool("brain_trigger").handler(ctx, { operation: "act", id })) as {
    trigger: { status: string };
  };
  expect(acted.trigger.status).toBe("acted");

  const history = (await tool("brain_trigger").handler(ctx, { operation: "history" })) as {
    triggers: Array<{ id: string }>;
  };
  expect(history.triggers.map((t) => t.id)).toEqual([id]);
});

test("brain_trigger scan on a bare vault is fail-soft", async () => {
  const result = (await tool("brain_trigger").handler(ctx, { operation: "scan" })) as {
    created: unknown[];
    candidates: number;
  };
  expect(Array.isArray(result.created)).toBe(true);
});

test("brain_trigger rejects unknown operations and terminal transitions", async () => {
  expect(() => tool("brain_trigger").handler(ctx, { operation: "explode" })).toThrow();
  const { created } = createTriggers(vault, [CANDIDATE], { now: NOW });
  await tool("brain_trigger").handler(ctx, { operation: "dismiss", id: created[0]!.id });
  expect(() =>
    tool("brain_trigger").handler(ctx, { operation: "act", id: created[0]!.id }),
  ).toThrow("terminal");
});

test("brain_brief view=morning surfaces pending triggers once per cooldown", async () => {
  createTriggers(vault, [CANDIDATE], { now: new Date() });
  const first = (await tool("brain_brief").handler(ctx, { view: "morning" })) as {
    text: string;
    triggers?: Array<{ id: string }>;
  };
  expect(first.triggers).toBeDefined();
  expect(first.text).toContain("Pending triggers");

  // Second brief inside the cooldown window: silent.
  const second = (await tool("brain_brief").handler(ctx, { view: "morning" })) as {
    text: string;
    triggers?: unknown[];
  };
  expect(second.triggers).toBeUndefined();
  expect(second.text).not.toContain("Pending triggers");
});

test("brain_brief view=morning without triggers keeps the legacy shape", async () => {
  const brief = (await tool("brain_brief").handler(ctx, { view: "morning" })) as Record<
    string,
    unknown
  >;
  expect(brief["triggers"]).toBeUndefined();
});
