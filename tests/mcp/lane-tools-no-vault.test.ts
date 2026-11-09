/**
 * The record-lane MCP tools on a server with no vault (task 2.10 WP6):
 * each writes and reads its lane as store records, refuses nothing for
 * want of a vault, and leaves the vault directory untouched.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";

import { dirname, join } from "node:path";

import { persistTension } from "../../src/core/brain/tensions.ts";
import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import { draftDeclaredSkillProposal } from "../../src/core/brain/skill-proposals.ts";
import { reconcileProceduralMemory } from "../../src/core/brain/procedural-memory.ts";
import { procedurePath } from "../../src/core/brain/paths.ts";
import { laneVaultRoot, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { VAULT_REQUIRED_CODE } from "../../src/mcp/tool-contract.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

const NOW = new Date("2026-11-07T12:00:00Z");

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function serverWithNoVault(): { server: MCPServer; env: LaneEnv } {
  lane = makeLaneEnv("no-vault");
  return { server: new MCPServer({ vault: null, configPath: lane.env.configPath }), env: lane };
}

function payload(result: Record<string, unknown>): Record<string, unknown> {
  const content = result["content"] as ReadonlyArray<{ text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function lanesOf(env: LaneEnv): string[] {
  return [...new Set(env.laneRecords().map((r) => String(r.body["lane"])))].toSorted();
}

test("brain_decision records, lists and parks with no vault", async () => {
  const { server, env } = serverWithNoVault();
  const before = env.vaultHash();
  const recorded = payload(
    await server.callTool("brain_decision", {
      action: "record",
      title: "Adopt Bun",
      chosen: "Bun",
      assumption: "Startup time matters",
      review_date: "2027-01-01",
    }),
  );
  expect(recorded["action"]).toBe("record");
  const listed = payload(await server.callTool("brain_decision", { action: "list" }));
  expect(JSON.stringify(listed)).toContain("adopt-bun");
  payload(
    await server.callTool("brain_decision", {
      action: "open",
      title: "Importer",
      question: "Keep the legacy importer?",
      options: ["keep", "drop"],
    }),
  );
  expect(lanesOf(env)).toEqual(["decisions", "obligations"]);
  expect(env.vaultHash()).toBe(before);
  expect(existsSync(laneVaultRoot(null))).toBe(false);
});

test("brain_obligation adds, lists and completes with no vault", async () => {
  const { server, env } = serverWithNoVault();
  const before = env.vaultHash();
  await server.callTool("brain_obligation", {
    operation: "add",
    title: "Pay rent",
    cadence: "monthly",
    anchor: "2026-11-01",
  });
  const listed = payload(await server.callTool("brain_obligation", { operation: "list" }));
  expect(JSON.stringify(listed)).toContain("pay-rent");
  await server.callTool("brain_obligation", { operation: "done", slug: "pay-rent" });
  expect(lanesOf(env)).toEqual(["obligations"]);
  expect(env.vaultHash()).toBe(before);
  expect(existsSync(laneVaultRoot(null))).toBe(false);
});

test("brain_tension lists a tension the store holds, and brain_pledge lists none, with no vault", async () => {
  const { server, env } = serverWithNoVault();
  const root = laneVaultRoot(null);
  const { record } = persistTension(
    root,
    {
      aId: "pref-tabs",
      bId: "pref-spaces",
      subject: "tabs use",
      jaccard: 0.6,
      aSign: "positive",
      bSign: "negative",
      aQuote: "Always use tabs.",
      bQuote: "Never use tabs.",
      action: "ask_user",
    },
    { agent: "tester", now: NOW },
  );
  // The seeding writer left nothing on disk at the no-vault root, so the
  // hash below (which reads "absent" for a missing root) proves the same.
  expect(existsSync(root)).toBe(false);
  const before = env.vaultHash();
  const tensions = payload(await server.callTool("brain_tension", { action: "list" }));
  expect((tensions["tensions"] as Array<{ slug: string }>).map((t) => t.slug)).toEqual([
    record.slug,
  ]);
  // A pledge cites a vault page, so no machine without a vault can hold
  // one (`add` refuses there): the empty list is the whole answer.
  const pledges = payload(await server.callTool("brain_pledge", { operation: "list" }));
  expect(pledges).toEqual({ operation: "list", pledges: [] });
  expect(env.vaultHash()).toBe(before);
  expect(existsSync(root)).toBe(false);
  expect(lanesOf(env)).toEqual(["tensions"]);
});

test("brain_entity, brain_trigger, brain_skill_proposals and brain_procedural_memory list what the store holds with no vault", async () => {
  const { server, env } = serverWithNoVault();
  const root = laneVaultRoot(null);
  upsertEntity(root, { category: "people", name: "Ada", agent: "@t", now: NOW });
  const { created } = createTriggers(
    root,
    [
      {
        kind: "contradiction",
        urgency: "high",
        reason: "pref-a contradicts pref-b",
        suggestedAction: "Retire one",
        sourceArtifacts: ["[[pref-a]]", "[[pref-b]]"],
        contextSnippets: ["pref-a: do X", "pref-b: never do X"],
        cooldownKey: "contradiction:pref-a:pref-b",
      },
    ],
    { now: NOW },
  );
  const drafted = draftDeclaredSkillProposal(root, {
    name: "Release ritual",
    body: "Tag, build, publish.",
    sourceRefs: ["[[notes/release]]"],
    now: NOW,
  });
  expect(drafted.outcome).toBe("created");
  writeLanePage(
    root,
    procedurePath(root, "deploy"),
    {
      schema_version: 1,
      kind: "brain-procedure",
      id: "proc-deploy",
      slug: "deploy",
      status: "active",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
    "# Deploy\n\nShip it.\n",
    { overwrite: false, existsErrorKind: "procedure", vaultForRelativePath: root },
  );
  reconcileProceduralMemory(root, { roots: [dirname(procedurePath(root, "deploy"))] });
  // The seeding writers left nothing on disk at the no-vault root, so the
  // hash below (which reads "absent" for a missing root) proves the same.
  expect(existsSync(root)).toBe(false);
  const before = env.vaultHash();

  const entities = payload(await server.callTool("brain_entity", { view: "list" }));
  expect(JSON.stringify(entities)).toContain("Ada");
  const triggers = payload(await server.callTool("brain_trigger", { operation: "list" }));
  expect(JSON.stringify(triggers)).toContain(created[0]!.id);
  const proposals = payload(await server.callTool("brain_skill_proposals", { operation: "list" }));
  expect(proposals["total"]).toBe(1);
  expect(JSON.stringify(proposals["proposals"])).toContain("release-ritual");
  const memory = payload(await server.callTool("brain_procedural_memory", { operation: "list" }));
  expect(memory["total"]).toBe(1);
  expect(JSON.stringify(memory["entries"])).toContain("proc-deploy");
  const history = payload(await server.callTool("brain_decision", { action: "history" }));
  expect(history["total"]).toBe(0);

  expect(env.vaultHash()).toBe(before);
  expect(existsSync(root)).toBe(false);
  expect(lanesOf(env)).toEqual([
    "entities",
    "procedural-memory",
    "procedures",
    "skill-proposals",
    "triggers",
  ]);
});

test("actions that read the user's notes refuse with vault_required naming the action", async () => {
  const { server } = serverWithNoVault();
  for (const [tool, args, named] of [
    ["brain_tension", { action: "detect" }, "brain_tension action=detect"],
    // Verify reads the subject notes a tension quotes.
    ["brain_tension", { action: "verify" }, "brain_tension action=verify"],
    // Refused before the slug is looked up, so the answer does not depend on it.
    ["brain_tension", { action: "verify", slug: "no-such" }, "brain_tension action=verify"],
    // A pledge cites a vault page as its source.
    [
      "brain_pledge",
      { operation: "add", title: "Send it", due: "2026-11-13", source: "notes/a.md" },
      "brain_pledge operation=add",
    ],
    [
      "brain_intake_pledges",
      {
        source: "notes/a.md",
        pledges: [{ title: "Send it", due: "2026-11-13", evidence: ["I will send it."] }],
      },
      "brain_intake_pledges",
    ],
  ] as const) {
    let caught: unknown;
    try {
      await server.callTool(tool, args);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect((caught as MCPError).data).toMatchObject({ code: VAULT_REQUIRED_CODE });
    expect((caught as MCPError).message).toContain(named);
  }
});

test("paths a lane tool answers with no vault name the record, never a host path", async () => {
  lane = makeLaneEnv("no-vault");
  // Local reach: the answer that would otherwise carry the absolute path.
  const server = new MCPServer(
    { vault: null, configPath: lane.env.configPath },
    { reach: TRANSPORT_REACH.local },
  );
  const set = payload(
    await server.callTool("brain_intention", { operation: "set", scope: "proj", text: "Ship" }),
  );
  expect(String(set["path"])).toMatch(/^Brain\/intentions\//);
  const shown = payload(
    await server.callTool("brain_intention", { operation: "show", scope: "proj" }),
  );
  expect(shown["path"]).toBe(set["path"]);
  const moved = payload(
    await server.callTool("brain_intention", { operation: "move", scope: "proj" }),
  );
  expect(String(moved["archive_path"])).toMatch(/^Brain\/intentions\//);
  const dead = payload(
    await server.callTool("brain_dead_ends", {
      operation: "record",
      approach: "Polling the API",
      reason: "Rate limited",
    }),
  );
  expect(String(dead["path"])).toMatch(/^Brain\/dead-ends\//);
  const listed = payload(await server.callTool("brain_dead_ends", { operation: "list" }));
  const entries = listed["entries"] as Array<{ path: string }>;
  expect(entries.map((e) => e.path)).toEqual([dead["path"] as string]);
});

test("the dead-end reach filter does not depend on the working directory", async () => {
  lane = makeLaneEnv("no-vault");
  const server = new MCPServer(
    { vault: null, configPath: lane.env.configPath },
    { reach: TRANSPORT_REACH.remote },
  );
  const dead = payload(
    await server.callTool("brain_dead_ends", {
      operation: "record",
      approach: "Polling the API",
      reason: "Rate limited",
    }),
  );
  const root = laneVaultRoot(null);
  const inside = join(root, "sub");
  mkdirSync(inside, { recursive: true });
  const cwd = process.cwd();
  const list = async () =>
    (
      payload(await server.callTool("brain_dead_ends", { operation: "list" }))["entries"] as Array<{
        path: string;
      }>
    ).map((e) => e.path);
  const elsewhere = await list();
  process.chdir(inside);
  try {
    expect(await list()).toEqual(elsewhere);
  } finally {
    process.chdir(cwd);
  }
  expect(elsewhere).toEqual([dead["path"] as string]);
});
