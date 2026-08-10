/**
 * `brain_trigger` MCP tool + morning-brief trigger section (Workspace
 * Insight Suite, t_cd1fee79).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import { TRIGGER_STATUSES, type InsightCandidate } from "../../src/core/brain/triggers/types.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let ctx: ServerContext;
const NOW = new Date("2099-06-03T10:00:00Z");

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

test("the tool's status enum is the shared status list, not a copy of it", () => {
  // The literal copy this replaces let a new status be accepted by the
  // handler's guard and rejected by the schema, with nothing failing.
  const schema = tool("brain_trigger").inputSchema as {
    properties: {
      status: { enum: string[] };
      operation: { enum: string[] };
    };
  };
  expect(schema.properties.status.enum).toEqual([...TRIGGER_STATUSES]);
  expect(schema.properties.operation.enum).toContain("suppress");
  expect(schema.properties.operation.enum).toContain("unsuppress");
});

test("brain_trigger suppress hides the trigger from list and shows it in history", async () => {
  const { created } = createTriggers(vault, [CANDIDATE], { now: NOW });
  const id = created[0]!.id;

  const suppressed = (await tool("brain_trigger").handler(ctx, {
    operation: "suppress",
    id,
  })) as { trigger: Record<string, unknown> };
  expect(suppressed.trigger["status"]).toBe("suppressed");
  expect(suppressed.trigger["suppressed_from"]).toBe("pending");
  expect(suppressed.trigger["occurrences"]).toBe(1);
  expect(suppressed.trigger["last_seen_at"]).toEqual(expect.any(String));

  const listed = (await tool("brain_trigger").handler(ctx, { operation: "list" })) as {
    triggers: Array<{ id: string }>;
  };
  expect(listed.triggers).toHaveLength(0);

  const history = (await tool("brain_trigger").handler(ctx, { operation: "history" })) as {
    triggers: Array<{ id: string }>;
  };
  expect(history.triggers.map((t) => t.id)).toEqual([id]);

  const restored = (await tool("brain_trigger").handler(ctx, {
    operation: "unsuppress",
    id,
  })) as { trigger: Record<string, unknown> };
  expect(restored.trigger["status"]).toBe("pending");
  expect(restored.trigger["suppressed_at"]).toBeNull();
});

test("brain_trigger unsuppress on a trigger that is not suppressed is an invalid request", async () => {
  const { created } = createTriggers(vault, [CANDIDATE], { now: NOW });
  expect(() =>
    tool("brain_trigger").handler(ctx, { operation: "unsuppress", id: created[0]!.id }),
  ).toThrow("not suppressed");
});

test("brain_trigger names every operation when it rejects one", async () => {
  expect(() => tool("brain_trigger").handler(ctx, { operation: "explode" })).toThrow("unsuppress");
});

// ── One corrupt record must not silence the whole surface ───────────────────

/** Seed one record and make a field of it unreadable, as a hand-edit would. */
function seedUnreadable(overrides: Partial<InsightCandidate> = {}): string {
  const { created } = createTriggers(vault, [{ ...CANDIDATE, ...overrides }], { now: NOW });
  const { path } = created[0]!;
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^occurrences: .*$/mu, "occurrences: many"),
    "utf8",
  );
  return path;
}

test("brain_trigger list names an unreadable record beside the readable ones", async () => {
  const { created } = createTriggers(vault, [CANDIDATE], { now: NOW });
  const brokenPath = seedUnreadable({ cooldownKey: "contradiction:pref-c:pref-d" });

  const listed = (await tool("brain_trigger").handler(ctx, { operation: "list" })) as {
    triggers: Array<{ id: string }>;
    unreadable: Array<{ path: string; key: string | null; error: string }>;
  };
  expect(listed.triggers.map((t) => t.id)).toEqual([created[0]!.id]);
  expect(listed.unreadable).toHaveLength(1);
  expect(listed.unreadable[0]!.path).toBe(brokenPath);
  expect(listed.unreadable[0]!.key).toBe("occurrences");
});

test("brain_brief view=morning reports an unreadable queue rather than an empty one", async () => {
  // The bare catch this replaces turned a refusal into an absent trigger
  // section, which reads exactly like a queue with nothing in it.
  seedUnreadable();
  const brief = (await tool("brain_brief").handler(ctx, { view: "morning" })) as {
    text: string;
    triggers?: unknown[];
    triggers_unreadable?: Array<{ key: string | null }>;
  };
  expect(brief.triggers).toBeUndefined();
  expect(brief.triggers_unreadable).toHaveLength(1);
  expect(brief.triggers_unreadable![0]!.key).toBe("occurrences");
  expect(brief.text).toContain("Unreadable triggers");
});

test("brain_brief view=morning without triggers keeps the legacy shape", async () => {
  const brief = (await tool("brain_brief").handler(ctx, { view: "morning" })) as Record<
    string,
    unknown
  >;
  expect(brief["triggers"]).toBeUndefined();
});
