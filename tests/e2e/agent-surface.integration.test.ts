/**
 * Agent Surface Suite end-to-end: one flow exercises the two-pass
 * catalog (small tools/list, hydrate, call a hidden tool), the skill
 * surface against the REAL repository skills/, and the session
 * lifecycle trio (scoped focus, intention chain, handoff note) on a
 * temp vault.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCPServer } from "../../src/mcp/server.ts";
import { resolveToolSurface } from "../../src/mcp/profiles.ts";
import { writeHandoffNote } from "../../src/core/brain/handoff.ts";
import { setIntention, moveIntentionToHistory } from "../../src/core/brain/intentions.ts";
import {
  normalizeSessionFocus,
  readActiveSessionFocus,
  writeSessionFocus,
} from "../../src/core/search/session-focus.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";

let vault: string;
const repoRoot = process.cwd();

beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-surface-e2e-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
});

async function rpc(server: MCPServer, id: number, method: string, params: unknown) {
  return (await server.handleRequest({
    jsonrpc: "2.0",
    id,
    method,
    params: params as Record<string, unknown>,
  }))! as { result?: any; error?: unknown };
}

test("catalog profile: compact list, hydrate schemas, call a hidden tool", async () => {
  const surface = resolveToolSurface({ profileName: "catalog" });
  const server = new MCPServer({ vault, repoRoot }, { scope: surface.scope });

  const list = await rpc(server, 1, "tools/list", {});
  expect(list.result.tools.length).toBe(7);

  const catalog = await rpc(server, 2, "tools/call", { name: "tool_hydrate", arguments: {} });
  const catalogPayload = catalog.result.structuredContent as { count: number };
  expect(catalogPayload.count).toBeGreaterThan(50);

  const hydrated = await rpc(server, 3, "tools/call", {
    name: "tool_hydrate",
    arguments: { names: ["list_skills"] },
  });
  const schemas = hydrated.result.structuredContent as { tools: Array<{ name: string }> };
  expect(schemas.tools[0]!.name).toBe("list_skills");

  // The hydrated (still unadvertised) tool is directly callable.
  const skills = await rpc(server, 4, "tools/call", { name: "list_skills", arguments: {} });
  const skillsPayload = skills.result.structuredContent as {
    count: number;
    skills: Array<{ name: string }>;
  };
  expect(skillsPayload.count).toBeGreaterThanOrEqual(5);
  expect(skillsPayload.skills.map((s) => s.name)).toContain("brain-memory");
});

test("get_skill serves the real repository skill content", async () => {
  const server = new MCPServer({ vault, repoRoot }, { scope: "full" });
  const r = await rpc(server, 5, "tools/call", {
    name: "get_skill",
    arguments: { name: "open-second-brain" },
  });
  const payload = r.result.structuredContent as { content: string };
  expect(payload.content).toContain("Open Second Brain");
});

test("session lifecycle trio: scoped focus, intention chain, handoff note", () => {
  const cfg = resolveSearchConfig({ vault });
  writeSessionFocus(cfg, normalizeSessionFocus({ query: "surface suite" }), "e2e-session");
  expect(readActiveSessionFocus(cfg, "e2e-session")?.query).toBe("surface suite");

  const chain = setIntention(vault, {
    scope: "e2e-session",
    text: "Finish the integration test",
    agent: "e2e-agent",
  });
  expect(chain.version).toBe(1);

  const handoff = writeHandoffNote(vault, {
    turns: [
      {
        turnId: "t1",
        timestamp: new Date().toISOString(),
        role: "user",
        text: "Wire the suite together.",
      },
      {
        turnId: "t2",
        timestamp: new Date().toISOString(),
        role: "assistant",
        text: "Done: suite wired. Next step: release.",
      },
    ],
    sessionId: "e2e-session",
    agent: "e2e-agent",
  });
  expect(existsSync(handoff.path)).toBe(true);

  const moved = moveIntentionToHistory(vault, { scope: "e2e-session" });
  expect(existsSync(moved.archivePath)).toBe(true);
});
