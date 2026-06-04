/**
 * `brain_write_session` MCP tool (Agent Write Contract Suite,
 * t_bc36a8a2 + t_0cc6fdff): one tool, op + kind discriminators, the
 * same envelopes as the CLI.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolTable, findTool, type ServerContext } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configPath: string;

const GOOD = "---\nkind: note\n---\n\n# MCP note\n\nBody.\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-ws-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: null };
}

function tool() {
  return findTool(buildToolTable("full"), "brain_write_session");
}

test("artifact flow: open -> bad submit -> corrected submit -> done", async () => {
  const opened = (await tool().handler(ctx(), {
    op: "open",
    kind: "artifact",
    target: "Brain/notes/mcp.md",
    agent: "mcp-agent",
  })) as Record<string, unknown>;
  expect(opened["status"]).toBe("needs-llm-step");
  const id = opened["session_id"] as string;

  const bad = (await tool().handler(ctx(), {
    op: "submit",
    session_id: id,
    text: "no frontmatter",
  })) as Record<string, unknown>;
  expect(bad["status"]).toBe("needs-correction");
  expect((bad["errors"] as Array<{ code: string }>).map((e) => e.code)).toContain(
    "frontmatter-missing",
  );

  const done = (await tool().handler(ctx(), {
    op: "submit",
    session_id: id,
    text: GOOD,
  })) as Record<string, unknown>;
  expect(done["status"]).toBe("done");
  expect(readFileSync(join(vault, "Brain", "notes", "mcp.md"), "utf8")).toContain("# MCP note");
});

test("panel flow: open -> persona steps -> synthesis -> committed note", async () => {
  const opened = (await tool().handler(ctx(), {
    op: "open",
    kind: "panel",
    topic: "Adopt MCP sessions",
    personas: ["technical", "risk"],
    agent: "mcp-agent",
  })) as Record<string, unknown>;
  expect(opened["step"]).toBe("persona:technical");
  const id = opened["session_id"] as string;

  await tool().handler(ctx(), { op: "submit", session_id: id, text: "Feasible." });
  await tool().handler(ctx(), { op: "submit", session_id: id, text: "Low risk." });
  const done = (await tool().handler(ctx(), {
    op: "submit",
    session_id: id,
    text: "Adopt.",
  })) as Record<string, unknown>;
  expect(done["status"]).toBe("done");
  expect(readFileSync(join(vault, done["target_path"] as string), "utf8")).toContain(
    "## Synthesis",
  );
});

test("status, list, abandon ops round-trip", async () => {
  const opened = (await tool().handler(ctx(), {
    op: "open",
    kind: "artifact",
    target: "Brain/notes/s.md",
  })) as Record<string, unknown>;
  const id = opened["session_id"] as string;

  const status = (await tool().handler(ctx(), { op: "status", session_id: id })) as Record<
    string,
    unknown
  >;
  expect(status["status"]).toBe("needs-llm-step");

  const list = (await tool().handler(ctx(), { op: "list" })) as Record<string, unknown>;
  expect((list["sessions"] as unknown[]).length).toBe(1);

  const abandoned = (await tool().handler(ctx(), { op: "abandon", session_id: id })) as Record<
    string,
    unknown
  >;
  expect(abandoned["status"]).toBe("failed");
});

test("structured request errors surface as MCP invalid-params", async () => {
  await expect(
    tool().handler(ctx(), { op: "open", kind: "artifact", target: "Brain/preferences/x.md" }),
  ).rejects.toThrow(/target rejected/);
  await expect(tool().handler(ctx(), { op: "bogus" })).rejects.toThrow(/op/);
  await expect(tool().handler(ctx(), { op: "submit" })).rejects.toThrow(/session_id/);
});

test("the tool is advertised in full scope but not writer scope", () => {
  expect(() => findTool(buildToolTable("full"), "brain_write_session")).not.toThrow();
  expect(() => findTool(buildToolTable("writer"), "brain_write_session")).toThrow();
});
